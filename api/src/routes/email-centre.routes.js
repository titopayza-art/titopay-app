"use strict";

const express = require("express");
const { AppError } = require("../lib/errors");
const { requireAuth } = require("../middleware/auth");
const { requireAdminPermission } = require("../middleware/rbac");
const { requireSuperAdmin } = require("../middleware/super-admin");
const { writeAuditLog } = require("../services/audit-service");
const email = require("../services/email-centre-service");

const router = express.Router();
router.use(requireAuth);
router.use((req, _res, next) => req.auth?.userType === "admin" ? next() : next(new AppError(403, "Admin access required")));

const permission = (name) => requireAdminPermission(email.EMAIL_PERMISSIONS[name]);
const actor = (req) => ({ userId:req.auth.userId, role:req.auth.role });
function templateScope(req){const role=String(req.auth.role||"").toLowerCase().replace(/[\s-]+/g,"_");if(role==="customer_support")return ["support_ticket_created","support_ticket_updated","support_ticket_resolved"];if(role==="compliance")return ["business_account_submitted","business_account_approved","business_account_rejected","kyc_submitted","kyc_approved","kyc_rejected"];if(role==="finance")return ["payment_receipt","wallet_top_up_receipt","money_transfer_receipt","qr_payment_receipt","payment_received","refund_confirmation"];return null;}

router.get("/dashboard", permission("VIEW"), async (req,res,next)=>{try{res.json({ok:true,...await email.dashboard(templateScope(req))});}catch(error){next(error);}});
router.get("/analytics", permission("VIEW"), async (req,res,next)=>{try{res.json({ok:true,...await email.analytics(req.query,templateScope(req))});}catch(error){next(error);}});
router.get("/templates", permission("VIEW"), async (req,res,next)=>{try{res.json({ok:true,items:await email.listTemplates(templateScope(req)),supportedVariables:Array.from(email.ALLOWED_VARIABLES)});}catch(error){next(error);}});
router.get("/templates/:id", permission("VIEW"), async (req,res,next)=>{try{res.json({ok:true,template:await email.getTemplate(req.params.id,templateScope(req)),supportedVariables:Array.from(email.ALLOWED_VARIABLES)});}catch(error){next(error);}});
router.post("/templates", permission("TEMPLATE_EDIT"), async (req,res,next)=>{try{res.status(201).json({ok:true,template:await email.saveTemplate(null,req.body,actor(req))});}catch(error){next(error);}});
router.put("/templates/:id", permission("TEMPLATE_EDIT"), async (req,res,next)=>{try{res.json({ok:true,template:await email.saveTemplate(req.params.id,req.body,actor(req))});}catch(error){next(error);}});
router.delete("/templates/:id", permission("TEMPLATE_DELETE"), async (req,res,next)=>{try{await email.deleteTemplate(req.params.id,actor(req));res.status(204).end();}catch(error){next(error);}});
router.post("/templates/:id/test", permission("TEST_SEND"), async (req,res,next)=>{try{const template=await email.getTemplate(req.params.id);const job=await email.queueEmail({recipient:req.body.to,templateKey:template.template_key,variables:req.body.variables||{},idempotencyKey:`admin-template-test:${req.auth.userId}:${Date.now()}`,metadata:{test:true,adminId:req.auth.userId}});if(job.skipped)throw new AppError(409,`Test email was not queued: ${job.reason}`);await writeAuditLog({actorType:"admin",actorId:req.auth.userId,action:"email_test_queued",entityType:"email_queue",entityId:job.id,metadata:{templateKey:template.template_key}});res.status(202).json({ok:true,job});}catch(error){next(error);}});

router.get("/queue", permission("VIEW"), async (req,res,next)=>{try{res.json({ok:true,...await email.listQueue({...req.query,allowedTemplates:templateScope(req)})});}catch(error){next(error);}});
router.get("/queue/:id", permission("VIEW"), async (req,res,next)=>{try{res.json({ok:true,item:await email.queueDetail(req.params.id,templateScope(req))});}catch(error){next(error);}});
router.post("/queue/:id/retry", permission("QUEUE_MANAGE"), async (req,res,next)=>{try{res.json({ok:true,item:await email.manageQueue(req.params.id,"retry",actor(req),templateScope(req))});}catch(error){next(error);}});
router.post("/queue/:id/cancel", permission("QUEUE_MANAGE"), async (req,res,next)=>{try{res.json({ok:true,item:await email.manageQueue(req.params.id,"cancel",actor(req),templateScope(req))});}catch(error){next(error);}});

router.get("/logs", permission("LOG_VIEW"), async (req,res,next)=>{try{res.json({ok:true,...await email.listLogs({...req.query,allowedTemplates:templateScope(req)})});}catch(error){next(error);}});
router.get("/logs/:id", permission("LOG_VIEW"), async (req,res,next)=>{try{res.json({ok:true,item:await email.logDetail(req.params.id,templateScope(req))});}catch(error){next(error);}});
router.get("/settings", permission("SETTINGS_EDIT"), async (_req,res,next)=>{try{res.json({ok:true,settings:await email.getSettings({masked:true})});}catch(error){next(error);}});
router.put("/settings", permission("SETTINGS_EDIT"), async (req,res,next)=>{try{res.json({ok:true,settings:await email.updateSettings(req.body,actor(req),{allowProvider:false})});}catch(error){next(error);}});
router.put("/provider", requireSuperAdmin, permission("PROVIDER_EDIT"), async (req,res,next)=>{try{res.json({ok:true,settings:await email.updateSettings(req.body,actor(req),{allowProvider:true})});}catch(error){next(error);}});
router.post("/provider/test", requireSuperAdmin, permission("PROVIDER_EDIT"), async (req,res,next)=>{try{const result=await email.providerTest(req.body.to);await writeAuditLog({actorType:"admin",actorId:req.auth.userId,action:"email_provider_test_sent",entityType:"email_settings",metadata:{messageId:result.messageId||null}});res.json({ok:true,result:{messageId:result.messageId||null,accepted:result.accepted||[]}});}catch(error){next(error);}});
router.post("/test", permission("TEST_SEND"), async (req,res,next)=>{try{const job=await email.queueEmail({recipient:req.body.to,templateKey:req.body.templateKey||"welcome_email",variables:req.body.variables||{},idempotencyKey:`admin-email-test:${req.auth.userId}:${Date.now()}`,metadata:{test:true,adminId:req.auth.userId}});if(job.skipped)throw new AppError(409,`Test email was not queued: ${job.reason}`);await writeAuditLog({actorType:"admin",actorId:req.auth.userId,action:"email_test_queued",entityType:"email_queue",entityId:job.id,metadata:{templateKey:req.body.templateKey||"welcome_email"}});res.status(202).json({ok:true,job});}catch(error){next(error);}});

module.exports = router;
