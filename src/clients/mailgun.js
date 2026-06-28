const formData = require("form-data");
const Mailgun = require("mailgun.js");

const mailgun = new Mailgun(formData);
const mg = mailgun.client({
  username: "api",
  key: process.env.MAILGUN_API_KEY
});


// Check

async function sendTeamInviteEmail({
  to,
  inviter_name,
  company_name,
  invite_url
}) {
  const domain = process.env.MAILGUN_DOMAIN;

  return mg.messages.create(domain, {
    from: process.env.MAILGUN_FROM,
    to,
    subject: `${inviter_name} invited you to Carrier Shark`,
    template: "team invite",

    "h:X-Mailgun-Variables": JSON.stringify({
      inviter_name,
      company_name,
      invite_url,
      expires_hours: "72"
    })
  });
}

async function sendPublicContactEmail({ to, name, email, company, topic, subject, message }) {
  const domain = process.env.MAILGUN_DOMAIN;

  const prefix = "Carrier Shark Contact";
  const topicTag = topic ? ` — ${topic}` : "";
  const companyTag = company ? ` (${company})` : "";

  return mg.messages.create(domain, {
    from: process.env.MAILGUN_FROM,
    to,
    subject: `${prefix}${topicTag}: ${subject}`,

    text: [
      "Source: Public contact submission",
      ``,
      `Name: ${name || "—"}`,
      `Email: ${email || "—"}`,
      company ? `Company: ${company}` : null,
      topic ? `Topic: ${topic}` : null,
      ``,
      `Subject: ${subject || "—"}`,
      ``,
      `Message:`,
      message || "",
      ``,
      `— Carrier Shark`,
    ].filter(Boolean).join("\n"),
  });
}

async function sendContractEmail({
  to,
  broker_name,
  carrier_name,
  dotnumber,
  agreement_type,
  link
}) {
  const domain = process.env.MAILGUN_DOMAIN;

  return mg.messages.create(domain, {
    from: process.env.MAILGUN_FROM,
    to,
    template: "carrier agreement",

    // Variables for the HTML template + subject
    "h:X-Mailgun-Variables": JSON.stringify({
      broker_name,
      carrier_name,
      dotnumber,
      agreement_type,
      link
    }),

    // Plain-text fallback (for basic email clients)
    text: [
      `${broker_name} sent you a carrier agreement to review.`,
      ``,
      `Carrier: ${carrier_name || "N/A"}`,
      `DOT: ${dotnumber}`,
      `Agreement: ${agreement_type}`,
      ``,
      `Review and accept here:`,
      link,
      ``,
      `This link expires in 72 hours.`,
      ``,
      `If you did not expect this, you can ignore this email.`,
      ``,
      `— Carrier Shark`
    ].join("\n")
  });
}




async function sendCarrierContractAcceptedEmail({
  to,                 // string or array
  broker_name,
  carrier_name,
  dotnumber,
  agreement_type,
  pdf_link,
  cert_link
}) {
  const domain = process.env.MAILGUN_DOMAIN;

  return mg.messages.create(domain, {
    from: process.env.MAILGUN_FROM,
    to,
    subject: `Agreement signed — ${agreement_type} (DOT ${dotnumber})`,
    template: "carrier_contract_accepted",

    "h:X-Mailgun-Variables": JSON.stringify({
      broker_name: broker_name || "",
      carrier_name: carrier_name || "",
      dotnumber: dotnumber || "",
      agreement_type: agreement_type || "Carrier Agreement",
      pdf_link: pdf_link || "",
      cert_link: cert_link || ""
    })
  });
}


async function sendBrokerContractAcceptedEmail({
  to,
  broker_name,
  carrier_name,
  dotnumber,
  agreement_type,
  accepted_name,
  accepted_title,
  accepted_email,
  pdf_link,
  cert_link,
  w9_link,
  insurance_link,
  ach_link,
  has_other_documents,
  portal_link
}) {
  const domain = process.env.MAILGUN_DOMAIN;

  return mg.messages.create(domain, {
    from: process.env.MAILGUN_FROM,
    to,
    subject: `Carrier accepted agreement — DOT ${dotnumber}`,
    template: "broker_contract_accepted",

    "h:X-Mailgun-Variables": JSON.stringify({
      broker_name: broker_name || "",
      carrier_name: carrier_name || "",
      dotnumber: dotnumber || "",
      agreement_type: agreement_type || "Carrier Agreement",
      accepted_name: accepted_name || "",
      accepted_title: accepted_title || "",
      accepted_email: accepted_email || "",
      pdf_link: pdf_link || "",
      cert_link: cert_link || "",
      w9_link: w9_link || "",
      insurance_link: insurance_link || "",
      ach_link: ach_link || "",
      has_other_documents: Boolean(has_other_documents),
      other_documents_note: has_other_documents
        ? "Additional documents were uploaded and can be viewed in Carrier Shark."
        : "",
      portal_link: portal_link || ""
    })
  });
}


async function sendPasswordResetEmail({ to, link }) {
  const domain = process.env.MAILGUN_DOMAIN;

  return mg.messages.create(domain, {
    from: process.env.MAILGUN_FROM,
    to,
    template: "password reset",
    "h:X-Mailgun-Variables": JSON.stringify({ link }),
    text: [
      "We received a request to reset your Carrier Shark password.",
      "",
      "Reset link:",
      link,
      "",
      "This link expires in 60 minutes.",
      "",
      "If you didn’t request this, you can ignore this email."
    ].join("\n")
  });
}


async function sendSupportTicketEmail({ to, ticketId, contactEmail, contactPhone, subject, message, userEmail }) {
  const domain = process.env.MAILGUN_DOMAIN;

  return mg.messages.create(domain, {
    from: process.env.MAILGUN_FROM,
    to,
    subject: `Carrier Shark Support Ticket #${ticketId}: ${subject}`,
    text: [
      `Ticket ID: #${ticketId}`,
      userEmail ? `Account Email: ${userEmail}` : null,
      `Contact Email: ${contactEmail}`,
      contactPhone ? `Contact Phone: ${contactPhone}` : null,
      ``,
      `Subject: ${subject}`,
      ``,
      `Message:`,
      message,
      ``,
      `Carrier Shark`,
    ].filter(Boolean).join("\n"),
  });
}


async function sendContractOtpEmail({ to, otp }) {
  const domain = process.env.MAILGUN_DOMAIN;

  return mg.messages.create(domain, {
    from: process.env.MAILGUN_FROM,
    to,
    subject: "Carrier Shark security code",

    // Plain text fallback (simple + defensible wording)
    text: [
      `Your Carrier Shark security code is: ${otp}`,
      ``,
      `This code expires in 5 minutes.`,
      ``,
      `If you did not request this code, you can ignore this email.`,
      ``,
      `— Carrier Shark`
    ].join("\n")
  });
}

async function sendVerificationEmail({ to, first_name, verify_url, expires_minutes }) {
  const domain = process.env.MAILGUN_DOMAIN;

  return mg.messages.create(domain, {
    from: process.env.MAILGUN_FROM,
    to,

    //  this must match your Mailgun template name exactly
    template: "email verification",

    // Variables for the HTML template + subject (Mailgun Variables)
    "h:X-Mailgun-Variables": JSON.stringify({
      first_name,
      verify_url,
      expires_minutes: String(expires_minutes ?? "60"),
    }),

    // Plain-text fallback
    text: [
      `Hi ${first_name || ""}`.trim(),
      ``,
      `Verify your Carrier Shark email to continue:`,
      verify_url,
      ``,
      `This link expires in ${expires_minutes ?? "60"} minutes.`,
      ``,
      `If you didn’t create this account, you can ignore this email.`,
      ``,
      `— Carrier Shark`
    ].join("\n")
  });
}

async function sendNewSignupAlertEmail({
  to,
  first_name,
  last_name,
  email,
  company_name
}) {
  const domain = process.env.MAILGUN_DOMAIN;

  return mg.messages.create(domain, {
    from: process.env.MAILGUN_FROM,
    to,
    subject: "New Carrier Shark account created",
    text: [
      `A new Carrier Shark account was just created.`,
      ``,
      `First name: ${first_name || ""}`,
      `Last name: ${last_name || ""}`,
      `Email: ${email || ""}`,
      `Company: ${company_name || ""}`,
      ``,
      `This user has created an account but may not have activated a plan yet.`,
      ``,
      `— Carrier Shark`
    ].join("\n")
  });
}

async function sendPaidActivationEmail({
  to,
  bcc,
  first_name,
  company_name,
  plan_name,
  login_url
}) {
  const domain = process.env.MAILGUN_DOMAIN;

  return mg.messages.create(domain, {
    from: process.env.MAILGUN_FROM,
    to,
    bcc: bcc || "robert@carriershark.com",
    subject: "Your Carrier Shark plan is active",
    template: "welcome email",
    "h:X-Mailgun-Variables": JSON.stringify({
      first_name,
      company_name,
      plan_name,
      login_url
    }),
    text: [
      `Hi${first_name ? ` ${first_name}` : ""},`,
      ``,
      `Your Carrier Shark ${plan_name || "paid"} plan is now active.`,
      `You can log in here:`,
      login_url,
      ``,
      `If you need help getting started, just reply and our team will help.`,
      ``,
      `— Carrier Shark`
    ].join("\n")
  });
}

async function sendPlanUpdatedEmail({
  to,
  bcc,
  first_name,
  company_name,
  previous_plan_name,
  plan_name,
  login_url
}) {
  const domain = process.env.MAILGUN_DOMAIN;

  return mg.messages.create(domain, {
    from: process.env.MAILGUN_FROM,
    to,
    bcc: bcc || "robert@carriershark.com",
    subject: "Your Carrier Shark plan was updated",
    template: "plan updated",
    "h:X-Mailgun-Variables": JSON.stringify({
      first_name,
      company_name,
      previous_plan_name,
      plan_name,
      login_url
    }),
    text: [
      `Hi${first_name ? ` ${first_name}` : ""},`,
      ``,
      `Your Carrier Shark plan was updated from ${previous_plan_name || "your previous plan"} to ${plan_name || "your new plan"}.`,
      `You can review your account here:`,
      login_url,
      ``,
      `If this change was unexpected, reply to this email and we can help.`,
      ``,
      `— Carrier Shark`
    ].join("\n")
  });
}

async function sendStarterWelcomeEmail({
  to,
  first_name,
  company_name,
  login_url
}) {
  const domain = process.env.MAILGUN_DOMAIN;

  return mg.messages.create(domain, {
    from: process.env.MAILGUN_FROM,
    to,
    bcc: "robert@carriershark.com",
    subject: "Your Carrier Shark Starter account is ready",
    template: "starter welcome",
    "h:X-Mailgun-Variables": JSON.stringify({
      first_name,
      company_name,
      login_url
    }),
    text: [
      `Welcome to Carrier Shark${first_name ? `, ${first_name}` : ""}`,
      ``,
      `Your Starter account is active.`,
      `You can now:`,
      `• Search carriers by DOT, MC, or company name`,
      `• Save carriers to monitor them`,
      `• Upload agreements and documents`,
      `• Track insurance, authority, and safety changes`,
      ``,
      `Log in here:`,
      login_url,
      ``,
      `Need help getting started? Reply to this email and our team can help.`,
      ``,
      `— Carrier Shark`
    ].join("\n")
  });
}


module.exports = {
  sendContractEmail,
  sendContractOtpEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
  sendNewSignupAlertEmail,
  sendPaidActivationEmail,
  sendStarterWelcomeEmail,
  sendPlanUpdatedEmail,
  sendSupportTicketEmail,
  sendCarrierContractAcceptedEmail,
  sendBrokerContractAcceptedEmail,
  sendTeamInviteEmail,
  sendPublicContactEmail
};
