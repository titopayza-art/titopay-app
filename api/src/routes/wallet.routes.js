const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireEnum, requireUuid } = require("../lib/validation");
const { createTransaction } = require("../services/transaction-service");
const {
  createWalletForUser,
  getPrimaryWalletForUser,
  listWalletsForUser,
  listWalletStatement,
  previewEmailStatement,
  emailWalletStatement
} = require("../services/wallet-service");
const { createInvite, trackInviteEvent, verifyRecipient } = require("../services/security-service");

const router = express.Router();

router.use(requireAuth);

router.post("/create", async (req, res, next) => {
  try {
    const kind = req.body.kind || req.auth.accountType || "personal";
    const result = await createWalletForUser(req.auth.userId, kind);
    res.status(result.created ? 201 : 200).json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.post("/transfer", async (req, res, next) => {
  try {
    const idempotencyKey = req.headers["idempotency-key"] || req.body.idempotencyKey;
    const transaction = await createTransaction(req.auth, {
      ...req.body,
      idempotencyKey,
      serviceCode: req.body.serviceCode || "wallet_transfer"
    });
    res.status(201).json({ ok: true, transaction });
  } catch (error) {
    next(error);
  }
});

router.post("/recipient/verify", async (req, res, next) => {
  try {
    const result = await verifyRecipient(req.auth, req.body);
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.post("/invites", async (req, res, next) => {
  try {
    const invite = await createInvite(req.auth, req.body);
    res.status(201).json({ ok: true, invite });
  } catch (error) {
    next(error);
  }
});

router.post("/invites/:id/events", async (req, res, next) => {
  try {
    const inviteId = requireUuid(req.params.id, "Invite ID");
    const eventType = requireEnum(req.body.eventType, ["created", "sent", "opened", "accepted", "expired"], "Invite event type");
    const event = await trackInviteEvent(req.auth, { ...req.body, eventType, inviteId });
    res.status(201).json({ ok: true, event });
  } catch (error) {
    next(error);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const wallets = await listWalletsForUser(req.auth.userId);
    res.json({ ok: true, items: wallets });
  } catch (error) {
    next(error);
  }
});

router.get("/me", async (req, res, next) => {
  try {
    const wallet = await getPrimaryWalletForUser(req.auth.userId);
    res.json({ ok: true, wallet });
  } catch (error) {
    next(error);
  }
});

router.get("/:id/statement", async (req, res, next) => {
  try {
    const walletId = requireUuid(req.params.id, "Wallet ID");
    const items = await listWalletStatement(req.auth.userId, walletId);
    res.json({ ok: true, items });
  } catch (error) {
    next(error);
  }
});

router.get("/:id/statement/email/preview", async (req,res,next)=>{
  try {
    const walletId=requireUuid(req.params.id,"Wallet ID");
    res.json({ok:true,preview:await previewEmailStatement(req.auth.userId,walletId,{from:req.query.from,to:req.query.to})});
  } catch(error){next(error);}
});

router.post("/:id/statement/email", async (req,res,next)=>{
  try {
    const walletId=requireUuid(req.params.id,"Wallet ID");
    const idempotencyKey=req.headers["idempotency-key"]||req.body.idempotencyKey;
    const result=await emailWalletStatement(req.auth.userId,walletId,{from:req.body.from,to:req.body.to,idempotencyKey,recipient:req.body.recipient},{ipAddress:req.ip,userAgent:req.get("user-agent")});
    res.status(202).json({ok:true,...result});
  } catch(error){next(error);}
});

module.exports = router;
