const GHL_API_BASE = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";
const LEAD_SOURCE = "Website";
const REFERRED_BY_OPTIONS = new Set(["", "Tejas Dhami", "Matt Bessa", "Other"]);
const LEGACY_REFERRED_BY_VALUES = new Map([
  ["Matt", "Matt Bessa"],
  ["Bessa", "Matt Bessa"],
]);

function getConfig() {
  const required = [
    "GHL_LOCATION_ID",
    "GHL_PRIVATE_INTEGRATION_TOKEN",
    "GHL_PIPELINE_ID",
    "GHL_PIPELINE_STAGE_ID",
    "GHL_REFERRED_BY_FIELD_ID",
    "GHL_ENQUIRY_TOPIC_FIELD_ID",
    "GHL_ENQUIRY_MESSAGE_FIELD_ID",
  ];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }

  return {
    locationId: process.env.GHL_LOCATION_ID,
    token: process.env.GHL_PRIVATE_INTEGRATION_TOKEN,
    pipelineId: process.env.GHL_PIPELINE_ID,
    pipelineStageId: process.env.GHL_PIPELINE_STAGE_ID,
    referredByFieldId: process.env.GHL_REFERRED_BY_FIELD_ID,
    enquiryTopicFieldId: process.env.GHL_ENQUIRY_TOPIC_FIELD_ID,
    enquiryMessageFieldId: process.env.GHL_ENQUIRY_MESSAGE_FIELD_ID,
  };
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function splitName(name) {
  const parts = name.trim().split(/\s+/);
  return {
    firstName: parts.shift() || "",
    lastName: parts.join(" "),
  };
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  if (typeof req.body === "string") {
    return JSON.parse(req.body);
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function ghlRequest(path, options = {}) {
  const { token } = getConfig();
  const response = await fetch(`${GHL_API_BASE}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Version: GHL_API_VERSION,
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error("GoHighLevel request failed.");
    error.status = response.status;
    error.details = body;
    throw error;
  }

  return body;
}

function parseSubmission(body) {
  const name = cleanString(body.name);
  const email = cleanString(body.email).toLowerCase();
  const phone = cleanString(body.phone);
  const topic = cleanString(body.topic);
  const message = cleanString(body.message);
  const rawReferredBy = cleanString(body.referredBy);
  const referredBy =
    LEGACY_REFERRED_BY_VALUES.get(rawReferredBy) || rawReferredBy;

  if (!name) {
    throw new Error("Name is required.");
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("A valid email is required.");
  }

  if (!phone) {
    throw new Error("Phone is required.");
  }

  if (!topic) {
    throw new Error("Topic is required.");
  }

  if (!REFERRED_BY_OPTIONS.has(referredBy)) {
    throw new Error("Invalid referred by value.");
  }

  return { name, email, phone, topic, message, referredBy };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, message: "Method not allowed." });
  }

  try {
    const config = getConfig();
    const submission = parseSubmission(await readBody(req));
    const { firstName, lastName } = splitName(submission.name);
    const customFields = [
      {
        id: config.enquiryTopicFieldId,
        field_value: submission.topic,
      },
    ];

    if (submission.message) {
      customFields.push({
        id: config.enquiryMessageFieldId,
        field_value: submission.message,
      });
    }

    if (submission.referredBy) {
      customFields.push({
        id: config.referredByFieldId,
        field_value: submission.referredBy,
      });
    }

    const contactResponse = await ghlRequest("/contacts/upsert", {
      method: "POST",
      body: JSON.stringify({
        locationId: config.locationId,
        firstName,
        lastName,
        name: submission.name,
        email: submission.email,
        phone: submission.phone,
        source: LEAD_SOURCE,
        tags: ["website-lead"],
        customFields,
      }),
    });
    const contactId = contactResponse.contact?.id || contactResponse.id;

    if (!contactId) {
      throw new Error("GoHighLevel did not return a contact id.");
    }

    const opportunityResponse = await ghlRequest("/opportunities/", {
      method: "POST",
      body: JSON.stringify({
        locationId: config.locationId,
        contactId,
        pipelineId: config.pipelineId,
        pipelineStageId: config.pipelineStageId,
        name: submission.name,
        status: "open",
        source: LEAD_SOURCE,
      }),
    });

    return res.status(201).json({
      ok: true,
      contactId,
      opportunityId:
        opportunityResponse.opportunity?.id || opportunityResponse.id || null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Submission failed.";
    const status =
      message.includes("required") ||
      message.includes("valid email") ||
      message.includes("Invalid")
        ? 400
        : 502;

    if (status >= 500) {
      console.error("Lead submission failed", {
        message,
        status: error.status,
        details: error.details,
      });
    }

    return res.status(status).json({
      ok: false,
      message:
        status === 400
          ? message
          : "We could not send your enquiry. Please try again.",
    });
  }
};
