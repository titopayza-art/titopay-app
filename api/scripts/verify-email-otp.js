const { config } = require("../src/config/env");

function loadNodemailer() {
  try {
    return require("nodemailer");
  } catch (error) {
    throw new Error("Nodemailer is not installed. Run npm install before verifying email delivery.");
  }
}

function required(value, label) {
  if (!value) throw new Error(`Missing required SMTP setting: ${label}`);
  return value;
}

async function main() {
  const recipient = process.env.TEST_OTP_EMAIL || process.argv[2];
  if (!recipient) {
    throw new Error("Provide TEST_OTP_EMAIL or pass the recipient as the first argument.");
  }

  const provider = config.integrations.email;
  const nodemailer = loadNodemailer();
  const transport = nodemailer.createTransport({
    host: required(provider.smtpHost, "SMTP_HOST"),
    port: provider.smtpPort,
    secure: provider.smtpSecure,
    auth: provider.smtpUser || provider.smtpPassword
      ? {
          user: required(provider.smtpUser, "SMTP_USER"),
          pass: required(provider.smtpPassword, "SMTP_PASSWORD")
        }
      : undefined,
    tls: {
      rejectUnauthorized: provider.smtpRejectUnauthorized
    }
  });

  await transport.verify();

  const code = "123456";
  const result = await transport.sendMail({
    from: required(provider.fromAddress, "EMAIL_FROM_ADDRESS"),
    to: recipient,
    subject: "Your TitoPay verification code",
    text: `Your TitoPay verification code is ${code}. It expires in ${Math.ceil(config.otpTtlSeconds / 60)} minutes. Never share this code.`
  });

  console.log(JSON.stringify({
    ok: true,
    provider: "smtp",
    recipient,
    messageId: result.messageId,
    accepted: result.accepted,
    rejected: result.rejected,
    response: result.response
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
