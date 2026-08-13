"use strict";

const crypto = require("crypto");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { sha256 } = require("../lib/crypto");
const { writeAuditLog } = require("./audit-service");
const { ensureEmailSchema, getSettings, queueEmail } = require("./email-centre-service");

const OTP_EVENTS = new Set(["login","new_device","new_browser","change_password","change_email","wallet_unlock","withdrawal","high_value_payment","business_approval","merchant_payout","api_key_generation","recovery","optional_mfa"]);

function purposeName(value) {
  const event=String(value||"").trim().toLowerCase();
  if(!OTP_EVENTS.has(event))throw new AppError(400,"Email OTP purpose is invalid");
  return event;
}
function generateNumericOtp(length=6) {
  const size=Math.min(8,Math.max(6,Number(length)||6));
  const minimum=10**(size-1),maximum=10**size;
  return String(crypto.randomInt(minimum,maximum));
}
function maskEmail(value="") { const [local,domain]=String(value).split("@"); return domain?`${local.slice(0,2)}***@${domain}`:"***"; }

async function shouldRequireEmailOtp(event) {
  const settings=await getSettings();
  return Boolean(settings.email_otp_enabled && settings.email_otp_events?.[purposeName(event)]);
}

async function shouldRequireLoginOtp(user,payload={}) {
  const settings=await getSettings();
  if(!settings.email_otp_enabled)return false;
  if(settings.email_otp_events?.login)return true;
  const fingerprint=String(payload.deviceFingerprint||payload.device_fingerprint||"").trim();
  if(settings.email_otp_events?.new_browser && !fingerprint)return true;
  if(settings.email_otp_events?.new_device){
    if(!fingerprint)return true;
    const column=user.user_type==="admin"?"admin_user_id":"user_id";
    const {rows}=await pool.query(`SELECT 1 FROM trusted_devices WHERE ${column}=$1 AND device_fingerprint=$2 AND revoked_at IS NULL LIMIT 1`,[user.id,fingerprint]);
    return !rows.length;
  }
  return false;
}

async function createChallengeInTransaction(user,event,meta,options) {
  const db=options.db;
  await ensureEmailSchema(db);
  const purpose=purposeName(event);
  if(!user?.email)throw new AppError(400,"An email address is required for Email OTP");
  const settings=await getSettings({db});
  if(!settings.email_otp_enabled && !options.force)throw new AppError(409,"Email OTP is disabled");
  if(options.requireEventEnabled && !settings.email_otp_events?.[purpose])throw new AppError(409,"Email OTP is not enabled for this action");
  const code=generateNumericOtp(settings.email_otp_length);
  const challengeId=crypto.randomUUID();
  const userType=user.user_type==="admin"?"admin":"customer";
  const revoked=await db.query(`UPDATE otp_codes SET revoked_at=NOW(),expires_at=NOW() WHERE user_type=$1 AND user_id=$2 AND purpose=$3 AND used_at IS NULL AND revoked_at IS NULL RETURNING id`,[userType,user.id,`email_otp:${purpose}`]);
  for(const previous of revoked.rows)await writeAuditLog({actorType:userType,actorId:user.id,action:"email_otp_revoked",entityType:"otp_challenge",entityId:previous.id,ipAddress:meta.ipAddress,userAgent:meta.userAgent,metadata:{purpose,reason:"replacement"},db});
  await db.query(`INSERT INTO otp_codes(id,user_type,user_id,purpose,code_hash,channels,resend_count,expires_at,metadata) VALUES($1,$2,$3,$4,$5,ARRAY['email']::text[],$6,NOW()+($7||' minutes')::interval,$8::jsonb)`,[challengeId,userType,user.id,`email_otp:${purpose}`,sha256(code),Number(options.resendCount||0),settings.email_otp_expiry_minutes,JSON.stringify({recipient:user.email,ipAddress:meta.ipAddress||null,device:meta.device||meta.deviceName||"Unknown device",location:meta.location||null,userAgent:meta.userAgent||null,...(options.metadata||{})})]);
  await writeAuditLog({actorType:userType,actorId:user.id,action:options.resendCount?"email_otp_resent":"email_otp_generated",entityType:"otp_challenge",entityId:challengeId,ipAddress:meta.ipAddress,userAgent:meta.userAgent,metadata:{purpose,resendCount:Number(options.resendCount||0)},db});
  const names=String(user.full_name||"").trim().split(/\s+/);
  const queueJob=await queueEmail({recipient:user.email,templateKey:"email_otp",userId:userType==="customer"?user.id:null,variables:{firstName:names[0]||"there",fullName:user.full_name,email:user.email,otp:code,expiryMinutes:String(settings.email_otp_expiry_minutes)},idempotencyKey:options.queueIdempotencyKey||`email-otp:${challengeId}`,metadata:{otpChallengeId:challengeId,purpose,...(options.metadata||{})},db});
  if(queueJob.skipped)throw new AppError(409,"Email OTP is temporarily unavailable");
  if(queueJob.deduplicated)throw new AppError(409,"This Email OTP request has already been received");
  await writeAuditLog({actorType:userType,actorId:user.id,action:"email_otp_sent",entityType:"otp_challenge",entityId:challengeId,ipAddress:meta.ipAddress,userAgent:meta.userAgent,metadata:{purpose,queueId:queueJob.id},db});
  return {challengeId,queueId:queueJob.id,otpRequired:true,authenticationMode:"email_otp",purpose,expiresInSeconds:settings.email_otp_expiry_minutes*60,resendCooldownSeconds:settings.email_otp_resend_cooldown_seconds,remainingAttempts:settings.email_otp_maximum_attempts,maskedDestination:maskEmail(user.email)};
}

async function createChallenge(user,event,meta={},options={}) {
  if(options.db)return createChallengeInTransaction(user,event,meta,options);
  await ensureEmailSchema();
  const purpose=purposeName(event);
  if(!user?.email)throw new AppError(400,"An email address is required for Email OTP");
  const settings=await getSettings();
  if(!settings.email_otp_enabled && !options.force)throw new AppError(409,"Email OTP is disabled");
  if(options.requireEventEnabled && !settings.email_otp_events?.[purpose])throw new AppError(409,"Email OTP is not enabled for this action");
  const code=generateNumericOtp(settings.email_otp_length);
  const challengeId=crypto.randomUUID();
  const userType=user.user_type==="admin"?"admin":"customer";
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const revoked=await client.query(`UPDATE otp_codes SET revoked_at=NOW(),expires_at=NOW() WHERE user_type=$1 AND user_id=$2 AND purpose=$3 AND used_at IS NULL AND revoked_at IS NULL RETURNING id`,[userType,user.id,`email_otp:${purpose}`]);
    for(const previous of revoked.rows)await writeAuditLog({actorType:userType,actorId:user.id,action:"email_otp_revoked",entityType:"otp_challenge",entityId:previous.id,ipAddress:meta.ipAddress,userAgent:meta.userAgent,metadata:{purpose,reason:"replacement"},db:client});
    await client.query(`INSERT INTO otp_codes(id,user_type,user_id,purpose,code_hash,channels,resend_count,expires_at,metadata) VALUES($1,$2,$3,$4,$5,ARRAY['email']::text[],$6,NOW()+($7||' minutes')::interval,$8::jsonb)`,[challengeId,userType,user.id,`email_otp:${purpose}`,sha256(code),Number(options.resendCount||0),settings.email_otp_expiry_minutes,JSON.stringify({recipient:user.email,ipAddress:meta.ipAddress||null,device:meta.device||meta.deviceName||"Unknown device",location:meta.location||null,userAgent:meta.userAgent||null,...(options.metadata||{})})]);
    await writeAuditLog({actorType:userType,actorId:user.id,action:options.resendCount?"email_otp_resent":"email_otp_generated",entityType:"otp_challenge",entityId:challengeId,ipAddress:meta.ipAddress,userAgent:meta.userAgent,metadata:{purpose,resendCount:Number(options.resendCount||0)},db:client});
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  const names=String(user.full_name||"").trim().split(/\s+/);
  await queueEmail({recipient:user.email,templateKey:"email_otp",userId:userType==="customer"?user.id:null,variables:{firstName:names[0]||"there",fullName:user.full_name,email:user.email,otp:code,expiryMinutes:String(settings.email_otp_expiry_minutes)},idempotencyKey:`email-otp:${challengeId}`,metadata:{otpChallengeId:challengeId,purpose,...(options.metadata||{})}});
  await writeAuditLog({actorType:userType,actorId:user.id,action:"email_otp_sent",entityType:"otp_challenge",entityId:challengeId,ipAddress:meta.ipAddress,userAgent:meta.userAgent,metadata:{purpose}}).catch((error)=>console.error("[email-otp] sent audit failed",{challengeId,message:error.message}));
  return {challengeId,otpRequired:true,authenticationMode:"email_otp",purpose,expiresInSeconds:settings.email_otp_expiry_minutes*60,resendCooldownSeconds:settings.email_otp_resend_cooldown_seconds,remainingAttempts:settings.email_otp_maximum_attempts,maskedDestination:maskEmail(user.email)};
}

async function loadChallenge(id,{forUpdate=false}={}) {
  const {rows}=await pool.query(`SELECT * FROM otp_codes WHERE id=$1 AND purpose LIKE 'email_otp:%' ${forUpdate?"FOR UPDATE":""}`,[id]);
  if(!rows[0])throw new AppError(400,"Email OTP challenge is invalid");
  return rows[0];
}

async function verifyChallenge(id,code,meta={}) {
  await ensureEmailSchema();const settings=await getSettings();const client=await pool.connect();let transactionOpen=false;
  try{await client.query("BEGIN");transactionOpen=true;const {rows}=await client.query("SELECT * FROM otp_codes WHERE id=$1 AND purpose LIKE 'email_otp:%' FOR UPDATE",[id]);const row=rows[0];
    if(!row)throw new AppError(400,"Verification code is invalid");if(row.revoked_at)throw new AppError(400,"Verification code has been revoked");if(row.used_at)throw new AppError(409,"Verification code has already been used");
    if(new Date(row.expires_at)<=new Date()){await writeAuditLog({actorType:row.user_type,actorId:row.user_id,action:"email_otp_expired",entityType:"otp_challenge",entityId:row.id,ipAddress:meta.ipAddress,userAgent:meta.userAgent,metadata:{purpose:row.purpose},db:client});await client.query("COMMIT");transactionOpen=false;throw new AppError(410,"Verification code has expired");}
    if(Number(row.attempts)>=settings.email_otp_maximum_attempts)throw new AppError(423,"Verification attempts are locked");
    if(!/^\d{6,8}$/.test(String(code||""))||sha256(code)!==row.code_hash){const next=Number(row.attempts)+1,remainingAttempts=Math.max(0,settings.email_otp_maximum_attempts-next);await client.query("UPDATE otp_codes SET attempts=$2 WHERE id=$1",[id,next]);await writeAuditLog({actorType:row.user_type,actorId:row.user_id,action:"email_otp_failed",entityType:"otp_challenge",entityId:row.id,ipAddress:meta.ipAddress,userAgent:meta.userAgent,metadata:{purpose:row.purpose,attempts:next},db:client});await client.query("COMMIT");transactionOpen=false;throw new AppError(next>=settings.email_otp_maximum_attempts?423:401,next>=settings.email_otp_maximum_attempts?"Verification attempts are locked":"Verification code is invalid",{remainingAttempts});}
    await client.query("UPDATE otp_codes SET used_at=NOW() WHERE id=$1",[id]);await writeAuditLog({actorType:row.user_type,actorId:row.user_id,action:"email_otp_verified",entityType:"otp_challenge",entityId:row.id,ipAddress:meta.ipAddress,userAgent:meta.userAgent,metadata:{purpose:row.purpose},db:client});await client.query("COMMIT");transactionOpen=false;return {...row,event:row.purpose.replace("email_otp:","")};
  }catch(error){if(transactionOpen){try{await client.query("ROLLBACK");}catch{}}throw error;}finally{client.release();}
}

async function resendChallenge(id,meta={}) {
  await ensureEmailSchema();const client=await pool.connect();let locked=false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))",[String(id)]);locked=true;
    const {rows:challenges}=await client.query("SELECT * FROM otp_codes WHERE id=$1 AND purpose LIKE 'email_otp:%'",[id]);const row=challenges[0],settings=await getSettings();
    if(!row)throw new AppError(400,"Email OTP challenge is invalid");
    if(row.used_at||row.revoked_at)throw new AppError(409,"Email OTP cannot be resent");
    if(Number(row.resend_count)>=settings.email_otp_maximum_resends)throw new AppError(429,"Email OTP resend limit reached");
    if(Date.now()-new Date(row.created_at).getTime()<settings.email_otp_resend_cooldown_seconds*1000)throw new AppError(429,"Please wait before requesting another code");
    const table=row.user_type==="admin"?"admin_users":"users";const {rows}=await client.query(`SELECT *, $2::text AS user_type FROM ${table} WHERE id=$1`,[row.user_id,row.user_type]);
    if(!rows[0])throw new AppError(404,"Account not found");
    return await createChallenge(rows[0],row.purpose.replace("email_otp:",""),meta,{force:true,resendCount:Number(row.resend_count)+1});
  } finally {if(locked)await client.query("SELECT pg_advisory_unlock(hashtext($1))",[String(id)]).catch(()=>{});client.release();}
}

async function revokeChallenge(id,actor) {const row=await loadChallenge(id);await pool.query("UPDATE otp_codes SET revoked_at=NOW(),expires_at=NOW() WHERE id=$1 AND used_at IS NULL",[id]);await writeAuditLog({actorType:"admin",actorId:actor.userId,action:"email_otp_revoked",entityType:"otp_challenge",entityId:id,metadata:{purpose:row.purpose}});return {ok:true};}

async function getDashboard(){await ensureEmailSchema();const {rows}=await pool.query(`SELECT COUNT(*) FILTER(WHERE created_at::date=CURRENT_DATE)::int sent_today,COUNT(*) FILTER(WHERE used_at::date=CURRENT_DATE)::int verified_today,COUNT(*) FILTER(WHERE expires_at<NOW() AND used_at IS NULL AND revoked_at IS NULL)::int expired,COUNT(*) FILTER(WHERE attempts>0 AND used_at IS NULL)::int failed,COALESCE(SUM(resend_count),0)::int resend_requests FROM otp_codes WHERE purpose LIKE 'email_otp:%'`);const delivered=await pool.query(`SELECT COUNT(*) FILTER(WHERE delivered_at IS NOT NULL)::int count,COALESCE(ROUND((AVG(EXTRACT(EPOCH FROM(delivered_at-sent_at))) FILTER (WHERE delivered_at IS NOT NULL))::numeric,0),0) average_delivery_seconds FROM email_queue WHERE template_key='email_otp' AND created_at::date=CURRENT_DATE`);return {...rows[0],delivered:Number(delivered.rows[0].count||0),average_delivery_seconds:Number(delivered.rows[0].average_delivery_seconds||0)};}
async function listLogs(query={}){await ensureEmailSchema();const limit=Math.min(100,Math.max(1,Number(query.limit)||25));const {rows}=await pool.query(`SELECT o.id,COALESCE(o.metadata->>'recipient',u.email,a.email) recipient,REPLACE(o.purpose,'email_otp:','') purpose,CASE WHEN o.used_at IS NOT NULL THEN 'verified' WHEN o.revoked_at IS NOT NULL THEN 'revoked' WHEN o.expires_at<NOW() THEN 'expired' WHEN o.attempts>0 THEN 'failed' ELSE 'sent' END status,o.created_at sent_time,o.expires_at,o.used_at,o.attempts,o.resend_count,o.metadata->>'ipAddress' ip_address,o.metadata->>'device' device,o.metadata->>'location' AS "location" FROM otp_codes o LEFT JOIN users u ON o.user_type='customer' AND u.id=o.user_id LEFT JOIN admin_users a ON o.user_type='admin' AND a.id=o.user_id WHERE o.purpose LIKE 'email_otp:%' ORDER BY o.created_at DESC LIMIT $1`,[limit]);return rows;}
async function getOtpSettings(){const s=await getSettings();return {enabled:s.email_otp_enabled,events:s.email_otp_events,otpLength:s.email_otp_length,expiryMinutes:s.email_otp_expiry_minutes,maximumAttempts:s.email_otp_maximum_attempts,maximumResends:s.email_otp_maximum_resends,resendCooldownSeconds:s.email_otp_resend_cooldown_seconds};}
async function updateOtpSettings(values,actor){await ensureEmailSchema();const current=await getOtpSettings();const integer=(value,fallback,min,max,label)=>{const n=Number(value??fallback);if(!Number.isInteger(n)||n<min||n>max)throw new AppError(400,`${label} is invalid`);return n;};const events={...current.events};for(const event of OTP_EVENTS)if(values.events?.[event]!==undefined)events[event]=Boolean(values.events[event]);const params=[Boolean(values.enabled??current.enabled),JSON.stringify(events),integer(values.otpLength,current.otpLength,6,8,"OTP length"),integer(values.expiryMinutes,current.expiryMinutes,1,30,"OTP expiry"),integer(values.maximumAttempts,current.maximumAttempts,1,10,"Maximum attempts"),integer(values.maximumResends,current.maximumResends,0,10,"Maximum resends"),integer(values.resendCooldownSeconds,current.resendCooldownSeconds,15,600,"Resend cooldown"),actor.userId];const {rows}=await pool.query(`UPDATE email_settings SET email_otp_enabled=$1,email_otp_events=$2::jsonb,email_otp_length=$3,email_otp_expiry_minutes=$4,email_otp_maximum_attempts=$5,email_otp_maximum_resends=$6,email_otp_resend_cooldown_seconds=$7,updated_by=$8,updated_at=NOW() WHERE id=TRUE RETURNING *`,params);await writeAuditLog({actorType:"admin",actorId:actor.userId,action:"email_otp_settings_changed",entityType:"email_settings",metadata:{enabled:params[0],events}});return getOtpSettings();}

module.exports={OTP_EVENTS,generateNumericOtp,shouldRequireEmailOtp,shouldRequireLoginOtp,createChallenge,verifyChallenge,resendChallenge,revokeChallenge,getDashboard,listLogs,getOtpSettings,updateOtpSettings};
