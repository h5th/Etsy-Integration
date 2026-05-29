const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'data.json');

// ── Load / Save data ──────────────────────────────────────────────
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { mappings: [], orders: [], logs: [], settings: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { mappings: [], orders: [], logs: [], settings: {} };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function addLog(data, msg, type = 'info') {
  const time = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  data.logs.unshift({ time, msg, type, timestamp: Date.now() });
  if (data.logs.length > 100) data.logs = data.logs.slice(0, 100);
}

// ── CJ Dropshipping: Get Token ────────────────────────────────────
async function getCJToken(settings) {
  const res = await axios.post('https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken', {
    email: settings.cjEmail,
    password: settings.cjPassword
  });
  if (res.data.result) return res.data.data.accessToken;
  throw new Error('CJ login gagal: ' + res.data.message);
}

// ── Etsy: Get Orders ─────────────────────────────────────────────
async function getEtsyOrders(settings) {
  const res = await axios.get(
    `https://openapi.etsy.com/v3/application/shops/${settings.etsyShopId}/receipts`,
    {
      headers: {
        'x-api-key': settings.etsyApiKey,
        'Authorization': `Bearer ${settings.etsyAccessToken}`
      },
      params: { limit: 25, was_paid: true, was_shipped: false }
    }
  );
  return res.data.results || [];
}

// ── CJ: Create Order ─────────────────────────────────────────────
async function createCJOrder(token, order, mapping) {
  const payload = {
    orderNumber: 'ETSY-' + order.receipt_id,
    shippingZip: order.shipping_address?.zip || '',
    shippingCountryCode: order.shipping_address?.country_iso || 'US',
    shippingPhone: order.shipping_address?.phone || '000',
    shippingName: order.shipping_address?.name || 'Customer',
    shippingAddress: order.shipping_address?.first_line || '',
    shippingCity: order.shipping_address?.city || '',
    shippingProvince: order.shipping_address?.state || '',
    products: [{
      vid: mapping.cjVid || '',
      pid: mapping.cjPid,
      quantity: order.quantity || 1,
      shippingName: 'CJPacket Ordinary'
    }]
  };
  const res = await axios.post(
    'https://developers.cjdropshipping.com/api2.0/v1/shopping/order/createOrder',
    payload,
    { headers: { 'CJ-Access-Token': token } }
  );
  if (res.data.result) return res.data.data;
  throw new Error('CJ order gagal: ' + res.data.message);
}

// ── Core: Check & Forward Orders ─────────────────────────────────
async function checkAndForwardOrders() {
  const data = loadData();
  const s = data.settings;

  if (!s.etsyApiKey || !s.etsyAccessToken || !s.etsyShopId || !s.cjEmail || !s.cjPassword) {
    addLog(data, 'Settings belum lengkap, skip check.', 'error');
    saveData(data);
    return { forwarded: 0, skipped: 0, error: 'Settings tidak lengkap' };
  }

  let forwarded = 0, skipped = 0;

  try {
    const etsyOrders = await getEtsyOrders(s);
    let cjToken = null;

    for (const order of etsyOrders) {
      const orderId = String(order.receipt_id);
      if (data.orders.find(o => o.id === orderId)) continue; // sudah diproses

      for (const transaction of (order.transactions || [])) {
        const etsySku = transaction.sku || transaction.product_id || '';
        const mapping = data.mappings.find(m => m.etsySku === etsySku);

        const orderRecord = {
          id: orderId,
          buyer: order.name || 'Customer',
          items: transaction.title || 'Item',
          date: new Date().toLocaleDateString('id-ID'),
          etsySku,
          status: 'pending',
          cjOrderId: null
        };

        if (!mapping) {
          orderRecord.status = 'no_mapping';
          addLog(data, `Order #${orderId}: SKU "${etsySku}" belum ada mapping, skip.`, 'error');
          skipped++;
        } else {
          try {
            if (!cjToken) cjToken = await getCJToken(s);
            const cjResult = await createCJOrder(cjToken, order, mapping);
            orderRecord.status = 'forwarded';
            orderRecord.cjOrderId = cjResult?.orderId || 'OK';
            addLog(data, `Order #${orderId} berhasil diteruskan ke CJ (CJ ID: ${orderRecord.cjOrderId})`, 'success');
            forwarded++;
          } catch (err) {
            orderRecord.status = 'error';
            addLog(data, `Order #${orderId} gagal dikirim ke CJ: ${err.message}`, 'error');
            skipped++;
          }
        }
        data.orders.unshift(orderRecord);
      }
    }
    addLog(data, `Cek selesai: ${forwarded} diteruskan, ${skipped} dilewati.`, forwarded > 0 ? 'success' : 'info');
  } catch (err) {
    addLog(data, 'Error saat cek order: ' + err.message, 'error');
  }

  saveData(data);
  return { forwarded, skipped };
}

// ── API Routes ────────────────────────────────────────────────────

// Get all data
app.get('/api/data', (req, res) => {
  res.json(loadData());
});

// Save settings
app.post('/api/settings', (req, res) => {
  const data = loadData();
  data.settings = { ...data.settings, ...req.body };
  addLog(data, 'Settings diperbarui.', 'info');
  saveData(data);
  res.json({ ok: true });
});

// Test connections
app.get('/api/test', async (req, res) => {
  const data = loadData();
  const s = data.settings;
  const result = { etsy: false, cj: false, etsyError: '', cjError: '' };

  try {
    await axios.get(
      `https://openapi.etsy.com/v3/application/shops/${s.etsyShopId}`,
      { headers: { 'x-api-key': s.etsyApiKey, 'Authorization': `Bearer ${s.etsyAccessToken}` } }
    );
    result.etsy = true;
  } catch (e) {
    result.etsyError = e.response?.data?.error || e.message;
  }

  try {
    await getCJToken(s);
    result.cj = true;
  } catch (e) {
    result.cjError = e.message;
  }

  addLog(data, `Tes koneksi: Etsy ${result.etsy ? 'OK' : 'GAGAL'}, CJ ${result.cj ? 'OK' : 'GAGAL'}`,
    result.etsy && result.cj ? 'success' : 'error');
  saveData(data);
  res.json(result);
});

// Add SKU mapping
app.post('/api/mapping', (req, res) => {
  const data = loadData();
  const { etsySku, cjPid, cjSku, cjVid } = req.body;
  if (!etsySku || !cjPid) return res.status(400).json({ error: 'etsySku dan cjPid wajib diisi' });
  if (data.mappings.find(m => m.etsySku === etsySku)) return res.status(400).json({ error: 'SKU sudah ada' });
  data.mappings.push({ etsySku, cjPid, cjSku: cjSku || '', cjVid: cjVid || '' });
  addLog(data, `Mapping ditambah: ${etsySku} → CJ ${cjPid}`, 'success');
  saveData(data);
  res.json({ ok: true });
});

// Delete SKU mapping
app.delete('/api/mapping/:sku', (req, res) => {
  const data = loadData();
  const sku = decodeURIComponent(req.params.sku);
  data.mappings = data.mappings.filter(m => m.etsySku !== sku);
  addLog(data, `Mapping dihapus: ${sku}`, 'info');
  saveData(data);
  res.json({ ok: true });
});

// Manual check orders
app.post('/api/check', async (req, res) => {
  const result = await checkAndForwardOrders();
  res.json(result);
});

// Clear logs
app.delete('/api/logs', (req, res) => {
  const data = loadData();
  data.logs = [];
  saveData(data);
  res.json({ ok: true });
});

// ── Auto check every 15 minutes ──────────────────────────────────
cron.schedule('*/15 * * * *', () => {
  const data = loadData();
  if (data.settings.autoForward) {
    console.log('[CRON] Checking orders...');
    checkAndForwardOrders();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server berjalan di port ${PORT}`));
