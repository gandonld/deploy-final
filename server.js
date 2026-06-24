// 蜂云装饰客户资料管理系统 - Node.js 后端代理
// 作用：接收浏览器请求，转发到 Supabase（使用 service_role 密钥）

const express = require('express');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// 企业微信群机器人 Webhook（新客户通知）
const WX_WEBHOOK_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=8f12c869-600d-4b30-a76e-ab248642c880';

// 发送企业微信通知（新客户录入）
async function sendWxNotify(record, isNew) {
  try {
    var name = record['f-name'] || '未填写';
    var phone = record['f-phone'] || '';
    var s = String(phone).replace(/\D/g, '');
    var maskedPhone = (s.length >= 7) ? s.slice(0, 3) + '****' + s.slice(-4) : phone;
    var area = record['f-area'] ? record['f-area'] + 'm²' : '未填写';
    var budget = record['f-budget'] || '未填写';
    var housetype = record['f-housetype'] || '未填写';
    var style = record['f-style'] || '未填写';
    var source = record['f-source'] || '';
    var urgency = record['f-urgency'] || '';

    var markdown = '## 🎉 新客户录入通知\n' +
      '> 蜂云装饰 · 客户资料管理系统\n' +
      '\n' +
      '**👤 姓名：**' + name + '\n' +
      '**📱 电话：**' + maskedPhone + '\n' +
      '**🏠 户型：**' + housetype + '\n' +
      '**📐 面积：**' + area + '\n' +
      '**💰 预算：**' + budget + '\n' +
      '**🎨 风格：**' + style + '\n' +
      (source ? '**📌 来源：**' + source + '\n' : '') +
      (urgency ? '**⏰ 紧急程度：**' + urgency + '\n' : '') +
      '\n<font color=\"warning\">请尽快联系客户！</font>';

    var resp = await fetch(WX_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: markdown } })
    });
    var result = await resp.json();
    if (result.errcode === 0) {
      console.log('[企业微信] 通知发送成功:', name);
    } else {
      console.error('[企业微信] 通知发送失败:', result.errmsg);
    }
  } catch(e) {
    console.error('[企业微信] 通知异常:', e.message);
  }
}

// Supabase 配置（服务端安全，不暴露到浏览器）
const SUPABASE_URL = 'https://aqbubauinyxqeuhxmpfq.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFxYnViYXVpbnl4cWV1aHhtcGZxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTk3MzY4MiwiZXhwIjoyMDk3NTQ5NjgyfQ._S_Ys_CNPJL-l3MgZPdplyJ2tsk6_-WBDramYWmfvQY';

app.use(express.json({ limit: '10mb' }));

// 静态文件
app.use(express.static(__dirname));

// ==================== API 代理 ====================

// 通用 Supabase 请求函数
async function supabaseRequest(method, path, body) {
  const url = SUPABASE_URL + '/rest/v1' + path;
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch(e) { data = null; }
  return { status: resp.status, ok: resp.ok, data };
}

// GET /api/health - 连通性检查
app.get('/api/health', async (req, res) => {
  try {
    const result = await supabaseRequest('GET', '/customers?select=count');
    res.json({ online: result.ok, count: result.ok && result.data ? result.data.length : 0 });
  } catch(e) {
    res.status(500).json({ online: false, error: e.message });
  }
});

// GET /api/customers - 查询所有客户
app.get('/api/customers', async (req, res) => {
  try {
    const result = await supabaseRequest('GET', '/customers?select=*&order=created_at.desc');
    if (!result.ok) {
      return res.status(result.status).json({ error: '数据库查询失败', detail: result.data });
    }
    // 转换 Supabase 行格式 → 前端格式
    const customers = (result.data || []).map(row => {
      const rec = row.data || {};
      rec.id = row.id;
      rec._created_at = row.created_at;
      rec._updated_at = row.updated_at;
      return rec;
    });
    res.json(customers);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/customers - 新增或更新客户（Upsert）
app.post('/api/customers', async (req, res) => {
  try {
    const record = req.body;
    if (!record || !record.id) {
      return res.status(400).json({ error: '缺少客户数据' });
    }
    const now = new Date().toISOString();
    const row = {
      id: record.id,
      name: record['f-name'] || '',
      phone: record['f-phone'] || '',
      data: record,
      updated_at: now
    };

    // 先检查是否存在
    const check = await supabaseRequest('GET', '/customers?id=eq.' + encodeURIComponent(record.id) + '&select=id');
    if (!check.ok) {
      return res.status(500).json({ error: '数据库查询失败' });
    }

    let result;
    if (check.data && check.data.length > 0) {
      // 更新
      row.created_at = check.data[0].created_at; // 保留原创建时间
      result = await supabaseRequest('PATCH', '/customers?id=eq.' + encodeURIComponent(record.id), row);
    } else {
      // 新增
      row.created_at = now;
      result = await supabaseRequest('POST', '/customers', [row]);
      // 新增客户，发送企业微信通知
      sendWxNotify(record, true).catch(function(){});
    }

    if (result.ok) {
      res.json({ success: true, id: record.id });
    } else {
      res.status(500).json({ error: '保存失败', detail: result.data });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/customers/:id - 删除单个客户
app.delete('/api/customers/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (id === 'all') {
      // 处理删除全部
      const result = await supabaseRequest('DELETE', '/customers?id=neq.0');
      if (result.ok) {
        res.json({ success: true, deleted: 'all' });
      } else {
        res.status(500).json({ error: '删除失败', detail: result.data });
      }
      return;
    }
    const result = await supabaseRequest('DELETE', '/customers?id=eq.' + encodeURIComponent(id));
    if (result.ok) {
      res.json({ success: true, id });
    } else {
      res.status(500).json({ error: '删除失败', detail: result.data });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// 首页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log('蜂云装饰 CRM 后端已启动: http://localhost:' + PORT);
  console.log('Supabase 代理: ' + SUPABASE_URL);
});
