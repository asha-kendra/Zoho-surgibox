# SurgiBox Package Slip — Zoho Catalyst App

A hosted package slip viewer built on Zoho Catalyst, pulling live data from Zoho Inventory.

## Usage

Open the slip URL with a `package_id` query param:

```
https://surgibox-package-slip-921165551.development.catalystappsail.com/app/?package_id=YOUR_PACKAGE_ID
```

The page will:
- Fetch package, sales order and customer details from Zoho Inventory
- Render a printable package slip
- Allow **Download as PDF** (browser print → Save as PDF)
- Allow **Email Customer** (sends directly via Zoho Inventory email API)

## Project Structure

```
├── catalyst.json                     # Catalyst project config
├── functions/
│   └── package-slip-api/
│       ├── index.js                  # Serverless function (Node.js, Advanced IO)
│       └── package.json
└── public/
    └── app/
        ├── index.html                # Package slip UI
        └── catalyst.config.js       # API base URL config
```

## Deploy Steps

1. **Install Catalyst CLI**
   ```bash
   npm install -g zcatalyst-cli
   ```

2. **Login to Catalyst**
   ```bash
   catalyst login
   ```

3. **Initialize project** (if first time)
   ```bash
   catalyst init
   # Select: surgibox-package-slip
   ```

4. **Set environment variables** in Catalyst console:
   - `ZOHO_CLIENT_ID`
   - `ZOHO_CLIENT_SECRET`
   - `ZOHO_REFRESH_TOKEN`

   Required OAuth scopes:
   - `ZohoInventory.packages.READ`
   - `ZohoInventory.salesorders.READ`
   - `ZohoInventory.contacts.READ`

5. **Install function dependencies**
   ```bash
   cd functions/package-slip-api && npm install
   ```

6. **Deploy**
   ```bash
   catalyst deploy
   ```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/package?package_id=XXX` | Fetch package + order + customer data |
| POST | `/api/send-email` | Send slip email to customer |

### POST /api/send-email body
```json
{
  "package_id": "xxx",
  "email": "override@example.com"  // optional, uses customer email if omitted
}
```

## Environment Variables

See `.env.example` for the required Zoho OAuth credentials.
Generate a refresh token at https://api-console.zoho.com/ with a Self Client.
