const https = require("https");
const { URLSearchParams } = require("url");

const ORG_ID = "921165551";

let cachedToken = null;
let tokenExpiry = 0;

function httpsPost(hostname, path, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = typeof data === "string" ? data : JSON.stringify(data);
    const req = https.request(
      { hostname, path, method: "POST", headers: { "Content-Length": Buffer.byteLength(body), ...headers } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try { resolve(JSON.parse(raw)); } catch (e) { resolve(raw); }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(hostname, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: "GET", headers }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); } catch (e) { resolve(raw); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token",
  }).toString();

  const data = await httpsPost("accounts.zoho.com", "/oauth/v2/token", params, {
    "Content-Type": "application/x-www-form-urlencoded",
  });

  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function zohoGet(path) {
  const token = await getAccessToken();
  const fullPath = `/inventory/v1${path}${path.includes("?") ? "&" : "?"}organization_id=${ORG_ID}`;
  return httpsGet("www.zohoapis.com", fullPath, { Authorization: `Zoho-oauthtoken ${token}` });
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

async function sendPackageSlipEmail(pkg, so, contact, toEmail) {
  const token = await getAccessToken();
  const body = JSON.stringify({
    to_mail_ids: [toEmail],
    subject: `Your SurgiBox Package Slip – ${pkg.package_number}`,
    body: `<p>Dear ${contact.contact_name || "Customer"},</p><p>Package slip for order <strong>${so.salesorder_number}</strong> is attached.</p>`,
    send_from_org_email_id: false,
  });
  const path = `/inventory/v1/salesorders/${so.salesorder_id}/packages/${pkg.package_id}/emails?organization_id=${ORG_ID}`;
  return httpsPost("www.zohoapis.com", path, body, {
    Authorization: `Zoho-oauthtoken ${token}`,
    "Content-Type": "application/json",
  });
}

module.exports = async (context, basicIO) => {
  const request = basicIO.getReq();
  const response = basicIO.getRes();

  response.set("Access-Control-Allow-Origin", "*");
  response.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.set("Access-Control-Allow-Headers", "Content-Type");

  if (request.method === "OPTIONS") {
    return response.status(204).send("");
  }

  const url = request.url || "";
  const query = request.query || {};

  try {
    if (request.method === "GET" && url.includes("/package")) {
      const packageId = query.package_id;
      if (!packageId) return response.status(400).json({ error: "package_id is required" });

      const pkg = await getPackageDetails(packageId);
      const so = await getSalesOrder(pkg.salesorder_id);
      const contact = await getContact(so.customer_id);

      return response.status(200).json({ success: true, data: { package: pkg, salesOrder: so, contact } });
    }

    if (request.method === "POST" && url.includes("/send-email")) {
      const body = request.body || {};
      const packageId = body.package_id;
      if (!packageId) return response.status(400).json({ error: "package_id is required" });

      const pkg = await getPackageDetails(packageId);
      const so = await getSalesOrder(pkg.salesorder_id);
      const contact = await getContact(so.customer_id);

      const toEmail = body.email || contact.email ||
        (contact.contact_persons || []).find((p) => p.email)?.email;

      if (!toEmail) return response.status(400).json({ error: "No customer email found" });

      await sendPackageSlipEmail(pkg, so, contact, toEmail);
      return response.status(200).json({ success: true, sent_to: toEmail });
    }

    return response.status(404).json({ error: "Route not found" });
  } catch (err) {
    console.error("Function error:", err.message);
    return response.status(500).json({ error: "Internal error", detail: err.message });
  }
};
