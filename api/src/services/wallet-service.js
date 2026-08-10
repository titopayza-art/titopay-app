const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { v4: uuidv4 } = require("uuid");
const { ensureWalletNumbersForAllWallets, generateUniqueWalletNumber } = require("../lib/wallet-id");
const { isMissingDbObjectError, logDbCompatibilityWarning } = require("../lib/db-safe");
const { calculateFee, roundMoney } = require("./pricing-service");
const { ensureEmailSchema, queueEmail } = require("./email-centre-service");
const { writeAuditLog } = require("./audit-service");

async function getPrimaryWalletForUser(userId) {
  await ensureWalletNumbersForAllWallets(pool);
  const { rows } = await pool.query(
    `SELECT *, wallet_number AS wallet_id FROM wallets
     WHERE user_id = $1
     ORDER BY created_at ASC
     LIMIT 1`,
    [userId]
  );
  if (!rows[0]) throw new AppError(404, "Wallet not found");
  return rows[0];
}

async function getRevenueWallet() {
  const { rows } = await pool.query(
    `SELECT *, wallet_number AS wallet_id FROM wallets
     WHERE kind = 'revenue' AND user_id IS NULL
     LIMIT 1`
  );
  if (!rows[0]) throw new AppError(500, "TitoPay revenue wallet is not configured");
  return rows[0];
}

async function listWalletsForUser(userId) {
  await ensureWalletNumbersForAllWallets(pool);
  const { rows } = await pool.query(
    `SELECT id, wallet_number, wallet_number AS wallet_id, kind, currency, available_balance, reserved_balance, status, created_at
     FROM wallets
     WHERE user_id = $1
     ORDER BY created_at ASC`,
    [userId]
  );
  return rows;
}

async function createWalletForUser(userId, kind = "personal") {
  const walletKind = ["personal", "business", "merchant"].includes(kind) ? kind : "personal";
  const { rows: existing } = await pool.query(
    `SELECT id, wallet_number, wallet_number AS wallet_id, kind, currency, available_balance, reserved_balance, status, created_at
     FROM wallets
     WHERE user_id = $1 AND kind = $2
     LIMIT 1`,
    [userId, walletKind]
  );
  if (existing[0]) return { wallet: existing[0], created: false };

  const walletNumber = await generateUniqueWalletNumber(pool);
  const { rows } = await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind)
     VALUES ($1, $2, $3, $4)
     RETURNING id, wallet_number, wallet_number AS wallet_id, kind, currency, available_balance, reserved_balance, status, created_at`,
    [uuidv4(), walletNumber, userId, walletKind]
  );
  return { wallet: rows[0], created: true };
}

async function listWalletStatement(userId, walletId) {
  const { rows } = await pool.query(
    `SELECT wl.*
     FROM wallet_ledger wl
     JOIN wallets w ON w.id = wl.wallet_id
     WHERE wl.wallet_id = $1 AND w.user_id = $2
     ORDER BY wl.created_at DESC
     LIMIT 100`,
    [walletId, userId]
  );
  return rows;
}

function normalizeStatementDate(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(new Date(`${text}T00:00:00Z`).getTime())) {
    throw new AppError(400, `${label} date is invalid`);
  }
  return text;
}

function statementPeriod(from, to) {
  if (from && to) return `${from} to ${to}`;
  if (from) return `From ${from}`;
  if (to) return `Up to ${to}`;
  return "All available wallet activity";
}

function statementMoney(value) {
  return roundMoney(Math.abs(Number(value || 0))).toFixed(2);
}

async function loadEmailStatementData(db, userId, walletId, range = {}, { lockWallet = false } = {}) {
  const from = normalizeStatementDate(range.from, "From");
  const to = normalizeStatementDate(range.to, "To");
  if (from && to && from > to) throw new AppError(400, "From date cannot be after To date");
  const { rows:accounts } = await db.query(
    `SELECT w.id,w.wallet_number,w.kind,w.currency,w.available_balance,u.email,u.full_name,u.account_type
     FROM wallets w JOIN users u ON u.id=w.user_id
     WHERE w.id=$1 AND w.user_id=$2 ${lockWallet ? "FOR UPDATE OF w" : ""}`,
    [walletId,userId]
  );
  const account = accounts[0];
  if (!account) throw new AppError(404,"Wallet not found");
  if (!account.email) throw new AppError(400,"Add a registered email address before requesting an Email Statement");
  const { rows } = await db.query(
    `SELECT wl.id,wl.entry_type,wl.amount,wl.balance_after,wl.reference,wl.created_at,
            COUNT(*) OVER()::int AS total_count,
            COALESCE(SUM(CASE WHEN wl.entry_type IN ('credit','release') THEN ABS(wl.amount) ELSE 0 END) OVER(),0) AS money_in_total,
            COALESCE(SUM(CASE WHEN wl.entry_type IN ('debit','reserve') THEN ABS(wl.amount) ELSE 0 END) OVER(),0) AS money_out_total
     FROM wallet_ledger wl
     WHERE wl.wallet_id=$1
       AND ($2::date IS NULL OR wl.created_at >= $2::date)
       AND ($3::date IS NULL OR wl.created_at < ($3::date + INTERVAL '1 day'))
     ORDER BY wl.created_at DESC
     LIMIT 100`,
    [walletId,from,to]
  );
  const totalCount=Number(rows[0]?.total_count||0);
  const totals={moneyIn:Number(rows[0]?.money_in_total||0),moneyOut:Number(rows[0]?.money_out_total||0)};
  return {account,rows,totalCount,from,to,period:statementPeriod(from,to),totals};
}

function renderStatementLines(statement) {
  const header="DATE | TYPE | AMOUNT | BALANCE | REFERENCE";
  const lines=statement.rows.map((row)=>{
    const direction=["credit","release"].includes(row.entry_type)?"+":"-";
    const date=new Date(row.created_at).toISOString().replace("T"," ").slice(0,16);
    return `${date} | ${String(row.entry_type).toUpperCase()} | ${direction}R ${statementMoney(row.amount)} | R ${statementMoney(row.balance_after)} | ${String(row.reference||"").slice(0,80)}`;
  });
  if(!lines.length)lines.push("No wallet movements were recorded for this period.");
  if(statement.totalCount>statement.rows.length)lines.push(`Showing the latest ${statement.rows.length} of ${statement.totalCount} wallet movements.`);
  return [header,...lines].join("\n");
}

async function previewEmailStatement(userId, walletId, range = {}) {
  const [statement,pricing]=await Promise.all([
    loadEmailStatementData(pool,userId,walletId,range),
    calculateFee("email_statement",0)
  ]);
  return {
    recipient:statement.account.email,
    period:statement.period,
    transactionCount:statement.totalCount,
    fee:pricing.fee,
    currency:statement.account.currency||"ZAR"
  };
}

async function emailWalletStatement(userId, walletId, range = {}, actor = {}) {
  const idempotencyKey=String(range.idempotencyKey||"").trim();
  if(!/^[A-Za-z0-9:_-]{8,200}$/.test(idempotencyKey))throw new AppError(400,"A valid idempotency key is required");
  await ensureEmailSchema();
  const pricing=await calculateFee("email_statement",0);
  const revenueWallet=pricing.fee>0?await getRevenueWallet():null;
  const client=await pool.connect();
  let transactionId;
  let queueJob;
  let reference;
  try {
    await client.query("BEGIN");
    const statement=await loadEmailStatementData(client,userId,walletId,range,{lockWallet:true});
    transactionId=uuidv4();
    reference=`TP-EST-${Date.now().toString(36).toUpperCase()}-${transactionId.slice(0,8).toUpperCase()}`;
    const names=String(statement.account.full_name||"").trim().split(/\s+/);
    const net=roundMoney(statement.totals.moneyIn-statement.totals.moneyOut);
    queueJob=await queueEmail({
      recipient:statement.account.email,
      templateKey:"email_statement",
      userId,
      idempotencyKey:`email-statement:${userId}:${idempotencyKey}`,
      db:client,
      variables:{
        firstName:names[0]||"there",lastName:names.slice(1).join(" "),fullName:statement.account.full_name,
        email:statement.account.email,accountType:statement.account.account_type,currency:statement.account.currency||"ZAR",
        statementPeriod:statement.period,statementReference:reference,transactionCount:statement.totalCount,
        moneyIn:statementMoney(statement.totals.moneyIn),moneyOut:statementMoney(statement.totals.moneyOut),
        netMovement:`${net<0?"-":""}${statementMoney(net)}`,statementLines:renderStatementLines(statement),
        statementFee:statementMoney(pricing.fee)
      },
      metadata:{serviceCode:"email_statement",transactionId,statementReference:reference,walletId,from:statement.from,to:statement.to,fee:pricing.fee}
    });
    if(queueJob.skipped)throw new AppError(409,"Email Statements are temporarily unavailable");
    if(queueJob.deduplicated){await client.query("ROLLBACK");return {queued:true,deduplicated:true,queueId:queueJob.id,fee:pricing.fee,recipient:statement.account.email,reference:queueJob.metadata?.statementReference||null};}
    if(Number(statement.account.available_balance)<pricing.fee)throw new AppError(400,"Insufficient balance for the R0.10 Email Statement fee");
    await client.query(
      `INSERT INTO transactions(id,user_id,wallet_id,service_code,amount,fee,total,status,direction,reference,recipient_reference,metadata)
       VALUES($1,$2,$3,'email_statement',0,$4,$4,'completed','debit',$5,$6,$7::jsonb)`,
      [transactionId,userId,walletId,pricing.fee,reference,statement.account.email,JSON.stringify({clientIdempotencyKey:idempotencyKey,emailQueueId:queueJob.id,from:statement.from,to:statement.to})]
    );
    if(pricing.fee>0){
      await applyWalletMovement(client,{walletId,transactionId,entryType:"debit",amount:pricing.fee,reference,metadata:{serviceCode:"email_statement",emailQueueId:queueJob.id}});
      await applyWalletMovement(client,{walletId:revenueWallet.id,transactionId,entryType:"credit",amount:pricing.fee,reference,metadata:{serviceCode:"email_statement",source:"fee"}});
      await client.query(`INSERT INTO revenue_ledger(id,transaction_id,service_code,fee_collected,revenue_wallet_id) VALUES($1,$2,'email_statement',$3,$4)`,[uuidv4(),transactionId,pricing.fee,revenueWallet.id]);
    }
    await writeAuditLog({actorType:"customer",actorId:userId,action:"email_statement_queued",entityType:"email_queue",entityId:queueJob.id,ipAddress:actor.ipAddress,userAgent:actor.userAgent,metadata:{transactionId,walletId,statementReference:reference,fee:pricing.fee,from:statement.from,to:statement.to},db:client});
    await client.query("COMMIT");
    return {queued:true,deduplicated:false,queueId:queueJob.id,transactionId,fee:pricing.fee,recipient:statement.account.email,reference};
  } catch(error) {
    await client.query("ROLLBACK").catch(()=>{});
    throw error;
  } finally {client.release();}
}

async function applyWalletMovement(client, { walletId, transactionId, entryType, amount, reference, metadata = {} }) {
  const movementAmount = Math.abs(Number(amount));
  if (!Number.isFinite(movementAmount) || movementAmount <= 0) {
    throw new AppError(400, "Wallet movement amount must be greater than zero");
  }
  const normalizedEntryType = String(entryType || "").trim().toLowerCase();
  const statementByType = {
    debit: {
      sql: `UPDATE wallets
            SET available_balance = available_balance - $2,
                updated_at = NOW()
            WHERE id = $1 AND available_balance >= $2
            RETURNING available_balance`,
      params: [walletId, movementAmount]
    },
    credit: {
      sql: `UPDATE wallets
            SET available_balance = available_balance + $2,
                updated_at = NOW()
            WHERE id = $1
            RETURNING available_balance`,
      params: [walletId, movementAmount]
    },
    reserve: {
      sql: `UPDATE wallets
            SET available_balance = available_balance - $2,
                reserved_balance = reserved_balance + $2,
                updated_at = NOW()
            WHERE id = $1 AND available_balance >= $2
            RETURNING available_balance`,
      params: [walletId, movementAmount]
    },
    release: {
      sql: `UPDATE wallets
            SET available_balance = available_balance + $2,
                reserved_balance = GREATEST(0, reserved_balance - $2),
                updated_at = NOW()
            WHERE id = $1
            RETURNING available_balance`,
      params: [walletId, movementAmount]
    }
  };
  const statement = statementByType[normalizedEntryType];
  if (!statement) throw new AppError(400, "Unsupported wallet movement type");
  const { rows } = await client.query(statement.sql, statement.params);
  if (!rows[0]) {
    // Zero rows means one of two very different things. `debit` and `reserve`
    // carry `AND available_balance >= $2`, so they also match nothing when the
    // wallet is real and simply does not hold enough — and until now both cases
    // told the customer "Wallet not found". Every losing leg of a concurrent
    // payment got a 404 claiming their wallet had vanished, and support went
    // looking for a data problem that was never there.
    //
    // Ask which it was. `credit` and `release` have no balance predicate, so for
    // those an empty result really does mean the wallet is missing.
    if (normalizedEntryType === "debit" || normalizedEntryType === "reserve") {
      const { rows: existing } = await client.query(
        "SELECT available_balance FROM wallets WHERE id = $1",
        [walletId]
      );
      if (existing[0]) {
        const available = Number(existing[0].available_balance || 0);
        throw new AppError(
          409,
          `Not enough available balance. This needs R${movementAmount.toFixed(2)} and R${available.toFixed(2)} is available. No wallet debit was made.`,
          { code: "INSUFFICIENT_BALANCE" }
        );
      }
    }
    throw new AppError(404, "Wallet not found");
  }
  await client.query(
    `INSERT INTO wallet_ledger
      (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [uuidv4(), walletId, transactionId || null, normalizedEntryType, movementAmount, rows[0].available_balance, reference, JSON.stringify(metadata)]
  );
  return rows[0];
}

async function listAllWallets() {
  try {
    await ensureWalletNumbersForAllWallets(pool);
    const { rows } = await pool.query(
      `SELECT
         w.*,
         w.wallet_number AS wallet_id,
         w.reserved_balance AS pending_balance,
         CASE
           WHEN w.kind IN ('business', 'merchant') THEN 'Business transactional limits'
           WHEN w.kind = 'personal' THEN 'Personal wallet limits'
           ELSE 'Platform wallet limits'
         END AS limits,
         COALESCE(u.fica_status, m.verification_status, 'platform') AS verification,
         COALESCE(kr.risk_rating, CASE WHEN u.profile_locked THEN 'high' ELSE 'low' END, 'low') AS risk_rating,
         u.full_name,
         u.username,
         u.email,
         u.phone,
         u.account_type,
         u.profile_locked,
         m.business_name
       FROM wallets w
       LEFT JOIN users u ON u.id = w.user_id
       LEFT JOIN merchants m ON m.user_id = w.user_id
       LEFT JOIN LATERAL (
         SELECT risk_rating
         FROM kyc_reviews
         WHERE user_id = u.id AND risk_rating IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 1
       ) kr ON TRUE
       ORDER BY w.kind, w.created_at DESC`
    );
    return rows;
  } catch (error) {
    if (!isMissingDbObjectError(error)) throw error;
    logDbCompatibilityWarning("wallets.listAllWallets", error);
    return [];
  }
}

module.exports = {
  ensureWalletNumbersForAllWallets,
  getPrimaryWalletForUser,
  getRevenueWallet,
  createWalletForUser,
  listWalletsForUser,
  listWalletStatement,
  previewEmailStatement,
  emailWalletStatement,
  applyWalletMovement,
  listAllWallets
};
