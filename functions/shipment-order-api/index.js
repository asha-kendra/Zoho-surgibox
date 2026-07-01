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

async function getShipmentOrder(shipmentId) {
  const data = await zohoGet(`/shipmentorders/${shipmentId}`);
  if (!data.shipmentorder) throw new Error(`Shipment order not found: ${shipmentId} — API: ${JSON.stringify(data).slice(0, 200)}`);
  return data.shipmentorder;
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
  const shipmentId = req.query.shipment_id;

  if (req.method === "GET" && shipmentId) {
    try {
      const shipment = await getShipmentOrder(shipmentId);
      const so = await getSalesOrder(shipment.salesorder_id);
      const contact = await getContact(so.customer_id);
      return res.status(200).json({ success: true, data: { shipment, salesOrder: so, contact } });
    } catch (err) {
      console.error(err.message);
      return res.status(500).json({ error: "Internal error", detail: err.message });
    }
  }

  return res.status(400).json({ error: "shipment_id query parameter is required", method: req.method, url: req.originalUrl });
});

module.exports = app;
