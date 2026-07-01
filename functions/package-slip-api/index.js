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
  if (!data.package) throw new Error(`Package not found: ${packageId} — API: ${JSON.stringify(data).slice(0, 200)}`);
  return data.package;
}

async function getSalesOrder(salesorderId) {
  const data = await zohoGet(`/salesorders/${salesorderId}`);
  if (!data.salesorder) throw new Error(`Sales order not found: ${salesorderId}`);
  return data.salesorder;
}

async function getContact(contactId) {
  const data = await zohoGet(`/contacts/${contactId}`);
  if (!data.contact) throw new Error(`Contact not found: ${contactId}`);
  return data.contact;
}

async function sendPackageSlipEmail(pkg, so, contact, toEmail) {
  const token = await getAccessToken();
  const body = JSON.stringify({
    send_from_org_email_id: true,
    to_mail_ids: [toEmail],
    cc_mail_ids: [],
    subject: `Your SurgiBox Package Slip – ${pkg.package_number}`,
    body: `<p>Dear ${contact.contact_name || "Customer"},</p><p>Package slip for order <strong>${so.salesorder_number}</strong> is attached.</p>`,
  });
  const path = `/inventory/v1/packages/${pkg.package_id}/email?organization_id=${ORG_ID}`;
  const result = await httpsPost("www.zohoapis.com", path, body, {
    Authorization: `Zoho-oauthtoken ${token}`,
    "Content-Type": "application/json",
  });
  console.log("Zoho email API response:", JSON.stringify(result));
  if (result.code !== 0) {
    throw new Error(`Zoho email API error: ${result.message || JSON.stringify(result)}`);
  }
  return result;
}

const express = require("express");
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).send("");
  next();
});

app.use(async (req, res) => {
  const url = req.originalUrl || req.url || "";
  // Route by query params: send-email has both package_id + email; package has only package_id
  const isEmail = req.method === "GET" && req.query.package_id && req.query.email;
  const isPackage = req.method === "GET" && req.query.package_id && !req.query.email;

  if (isPackage) {
    const packageId = req.query.package_id;
    if (!packageId) return res.status(400).json({ error: "package_id is required" });
    try {
      const pkg = await getPackageDetails(packageId);
      const so = await getSalesOrder(pkg.salesorder_id);
      const contact = await getContact(so.customer_id);
      return res.status(200).json({ success: true, data: { package: pkg, salesOrder: so, contact } });
    } catch (err) {
      console.error(err.message);
      return res.status(500).json({ error: "Internal error", detail: err.message });
    }
  }

  if (isEmail) {
    const packageId = req.query.package_id;
    if (!packageId) return res.status(400).json({ error: "package_id is required" });
    try {
      const pkg = await getPackageDetails(packageId);
      const so = await getSalesOrder(pkg.salesorder_id);
      const contact = await getContact(so.customer_id);
      const toEmail = req.query.email || contact.email ||
        (contact.contact_persons || []).find((p) => p.email)?.email;
      if (!toEmail) return res.status(400).json({ error: "No customer email found" });
      const zohoResult = await sendPackageSlipEmail(pkg, so, contact, toEmail);
      return res.status(200).json({ success: true, sent_to: toEmail, zoho: zohoResult });
    } catch (err) {
      console.error(err.message);
      return res.status(500).json({ error: "Internal error", detail: err.message });
    }
  }

  return res.status(404).json({ error: "Route not found", method: req.method, url });
});

module.exports = app;
