"use strict";

const express=require("express");
const {requireAuth}=require("../middleware/auth");
const {requireAdminPermission}=require("../middleware/rbac");
const {requireSuperAdmin}=require("../middleware/super-admin");
const otp=require("../services/email-otp-service");
const router=express.Router();
router.use(requireAuth);
router.get("/dashboard",requireAdminPermission("EMAIL_OTP_VIEW"),async(_req,res,next)=>{try{res.json({ok:true,metrics:await otp.getDashboard()});}catch(error){next(error);}});
router.get("/logs",requireAdminPermission("EMAIL_OTP_LOGS"),async(req,res,next)=>{try{res.json({ok:true,items:await otp.listLogs(req.query)});}catch(error){next(error);}});
router.get("/settings",requireAdminPermission("EMAIL_OTP_VIEW"),async(_req,res,next)=>{try{res.json({ok:true,settings:await otp.getOtpSettings(),events:Array.from(otp.OTP_EVENTS)});}catch(error){next(error);}});
router.put("/settings",requireSuperAdmin,requireAdminPermission("EMAIL_OTP_SETTINGS"),async(req,res,next)=>{try{res.json({ok:true,settings:await otp.updateOtpSettings(req.body,{userId:req.auth.userId})});}catch(error){next(error);}});
router.post("/:id/resend",requireAdminPermission("EMAIL_OTP_RESEND"),async(req,res,next)=>{try{res.json({ok:true,...await otp.resendChallenge(req.params.id,{ipAddress:req.ip,userAgent:req.get("user-agent"),deviceName:"Admin requested resend"})});}catch(error){next(error);}});
router.post("/:id/revoke",requireSuperAdmin,requireAdminPermission("EMAIL_OTP_SETTINGS"),async(req,res,next)=>{try{res.json(await otp.revokeChallenge(req.params.id,{userId:req.auth.userId}));}catch(error){next(error);}});
module.exports=router;
