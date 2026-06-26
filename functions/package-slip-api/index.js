const axios = require("axios");

const ORG_ID = "921165551";
const ZOHO_ACCOUNTS_URL = "https://accounts.zoho.com/oauth/v2/token";
const ZOHO_INVENTORY_URL = "https://www.zohoapis.com/inventory/v1";

// ─── Token Management ───────────────────────────────────────────────────────

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const catalyst = require("zcatalyst-sdk-node");
  const env = catalyst.env();

  const params = new URLSearchParams({
    refresh_token: env.ZOHO_REFRESH_TOKEN,
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token",
  });

  const res = await axios.post(ZOHO_ACCOUNTS_URL, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  cachedToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return cachedToken;
}

// ─── Zoho Inventory Helpers ─────────────────────────────────────────────────

async function zohoGet(path, params = {}) {
  const token = await getAccessToken();
  const res = await axios.get(`${ZOHO_INVENTORY_URL}${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { organization_id: ORG_ID, ...params },
  });
  return res.data;
}

async function getPackageDetails(packageId) {
  const data = await zohoGet(`/packages/${packageId}`);
  return data.package;
}

async function getSalesOrder(salesorderId) {
  const data = await zohoGet(`/salesorders/${salesorderId}`);
  return data.salesorder;
}

async function getContact(contactId) {
  const data = await zohoGet(`/contacts/${contactId}`);
  return data.contact;
}

// ─── Email Sender ────────────────────────────────────────────────────────────

async function sendPackageSlipEmail(packageData, salesOrder, contact, toEmail) {
  const token = await getAccessToken();

  const subject = `Your SurgiBox Package Slip – ${packageData.package_number}`;
  const body = buildEmailBody(packageData, salesOrder, contact);

  await axios.post(
    `${ZOHO_INVENTORY_URL}/salesorders/${salesOrder.salesorder_id}/packages/${packageData.package_id}/emails`,
    {
      to_mail_ids: [toEmail],
      subject,
      body,
      send_from_org_email_id: false,
    },
    {
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        "Content-Type": "application/json",
      },
      params: { organization_id: ORG_ID },
    }
  );
}

function buildEmailBody(pkg, so, contact) {
  const items = (pkg.line_items || [])
    .map(
      (li) =>
        `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;">${li.name || li.description || "—"}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${li.quantity}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;">${li.unit || "—"}</td>
        </tr>`
    )
    .join("");

  return `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
  <div style="background:#1a3a5c;padding:24px 32px;border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:24px;">SurgiBox Inc.</h1>
    <p style="color:#a8c4e0;margin:4px 0 0;">Package Slip</p>
  </div>
  <div style="background:#fff;padding:32px;border:1px solid #e2e8f0;">
    <p>Dear ${contact.contact_name || "Customer"},</p>
    <p>Please find your package slip details below for order <strong>${so.salesorder_number}</strong>.</p>
    <table style="width:100%;border-collapse:collapse;margin:20px 0;">
      <thead>
        <tr style="background:#f0f4f8;">
          <th style="padding:10px 12px;text-align:left;">Item</th>
          <th style="padding:10px 12px;text-align:center;">Qty</th>
          <th style="padding:10px 12px;text-align:left;">Unit</th>
        </tr>
      </thead>
      <tbody>${items}</tbody>
    </table>
    <p style="color:#666;font-size:13px;">Package #: ${pkg.package_number} | Date: ${pkg.date}</p>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">
    <p style="color:#888;font-size:12px;">SurgiBox Inc. | Massachusetts, USA</p>
  </div>
</div>`;
}

// ─── CORS Headers ────────────────────────────────────────────────────────────

function setCORS(response) {
  response.set("Access-Control-Allow-Origin", "*");
  response.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.set("Access-Control-Allow-Headers", "Content-Type");
}

// ─── Route Handler ───────────────────────────────────────────────────────────

module.exports = async (context, request, response) => {
  setCORS(response);

  if (request.method === "OPTIONS") {
    return response.status(204).send("");
  }

  const url = request.url || "";
  const query = request.query || {};

  try {
    // GET /api/package?package_id=xxx
    if (request.method === "GET" && url.includes("/package")) {
      const packageId = query.package_id;
      if (!packageId) {
        return response.status(400).json({ error: "package_id is required" });
      }

      const pkg = await getPackageDetails(packageId);
      const salesorderId = pkg.salesorder_id;
      const so = await getSalesOrder(salesorderId);
      const contact = await getContact(so.customer_id);

      return response.status(200).json({
        success: true,
        data: { package: pkg, salesOrder: so, contact },
      });
    }

    // POST /api/send-email { package_id, email }
    if (request.method === "POST" && url.includes("/send-email")) {
      const body = request.body || {};
      const packageId = body.package_id;
      const overrideEmail = body.email;

      if (!packageId) {
        return response.status(400).json({ error: "package_id is required" });
      }

      const pkg = await getPackageDetails(packageId);
      const so = await getSalesOrder(pkg.salesorder_id);
      const contact = await getContact(so.customer_id);

      const toEmail =
        overrideEmail ||
        contact.email ||
        (contact.contact_persons || []).find((p) => p.email)?.email;

      if (!toEmail) {
        return response.status(400).json({ error: "No customer email found" });
      }

      await sendPackageSlipEmail(pkg, so, contact, toEmail);
      return response.status(200).json({ success: true, sent_to: toEmail });
    }

    return response.status(404).json({ error: "Route not found" });
  } catch (err) {
    console.error("Function error:", err?.response?.data || err.message);
    return response.status(500).json({
      error: "Internal error",
      detail: err?.response?.data?.message || err.message,
    });
  }
};
