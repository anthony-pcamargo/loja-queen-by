require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const mercadopago = require('mercadopago');
const path = require('path'); 

const app = express();
const port = 3001;

app.use(express.json());
app.use(cors());

app.use(express.static(path.join(__dirname)));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const client = new mercadopago.MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

// --- MIDDLEWARE DE AUTENTICAÇÃO DE ADMIN ---
async function adminAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Não autorizado: Token não fornecido ou mal formatado' });
    }
    const token = authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Não autorizado: Token não encontrado' });
    }
    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) {
            return res.status(401).json({ error: 'Não autorizado: Token inválido' });
        }
        if (user.email === process.env.ADMIN_EMAIL) {
            req.user = user;
            next();
        } else {
            return res.status(403).json({ error: 'Não autorizado: Acesso negado' });
        }
    } catch (e) {
        res.status(500).json({ error: 'Erro interno no servidor de autenticação' });
    }
}

// --- MIDDLEWARE DE AUTENTICAÇÃO DE CLIENTE ---
async function clientAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Não autorizado: Token não fornecido' });
    }
    const token = authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Não autorizado: Token não encontrado' });
    }
    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) {
            return res.status(401).json({ error: 'Não autorizado: Token inválido' });
        }
        req.user = user; 
        next();
    } catch (e) {
        res.status(500).json({ error: 'Erro interno no servidor de autenticação' });
    }
}


// --- ROTAS DE PÁGINAS ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});


// --- ROTAS DA API PÚBLICA (PRODUTOS) ---
app.get('/api/products', async (req, res) => {
    const { data, error } = await supabase.from('products').select('*').order('id');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// --- ROTAS AUTENTICADAS DO CLIENTE ---
app.get('/api/client/orders/:userId', clientAuth, async (req, res) => {
    const { userId } = req.params;
    if (req.user.id !== userId) {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    const { data, error } = await supabase.from('orders')
        .select('*')
        .eq('user_id', userId) 
        .order('created_at', { ascending: false });
    
    if (error) {
        console.error("Erro ao buscar histórico:", error);
        return res.status(500).json({ error: error.message });
    }
    res.json(data);
});

// ROTA DE CHECKOUT REAL
app.post('/api/checkout', async (req, res) => {
    const { customerInfo, cart, total, userId } = req.body;
    const siteUrl = `http://localhost:${port}`;

    try {
        for (const item of cart) {
            const { data: p } = await supabase.from('products').select('stock').eq('id', item.id).single();
            if (!p || p.stock < item.quantity) throw new Error(`Estoque insuficiente: ${item.name}`);
        }
        const { data: order, error: orderError } = await supabase.from('orders').insert([{
            customer_name: customerInfo.name,
            customer_email: customerInfo.email,
            shipping_address: customerInfo.address,
            total,
            items: cart,
            user_id: userId || null,
            status: 'Aguardando Pagamento'
        }]).select().single();

        if (orderError) throw orderError;

        const preference = new mercadopago.Preference(client);
        const mpResponse = await preference.create({
            body: {
                items: cart.map(i => ({ title: i.name, quantity: Number(i.quantity), unit_price: Number(i.price), currency_id: 'BRL' })),
                payer: { email: customerInfo.email, name: customerInfo.name },
                external_reference: order.id.toString(),
                back_urls: {
                    success: `${siteUrl}`, 
                    failure: `${siteUrl}`,
                    pending: `${siteUrl}`
                },
                payment_methods: { installments: 12 }
            }
        });
        res.json({ status: 'success', paymentUrl: mpResponse.init_point });
    } catch (error) {
        res.status(400).json({ status: 'error', message: error.message });
    }
});

// ===== ROTA DO BOTÃO DE TESTE =====
app.post('/api/checkout-teste', async (req, res) => {
    const { customerInfo, cart, total, userId } = req.body;

    try {
        // 1. (Opcional, mas bom) Verifica o estoque
        for (const item of cart) {
            const { data: p } = await supabase.from('products').select('stock').eq('id', item.id).single();
            if (!p || p.stock < item.quantity) throw new Error(`Estoque insuficiente: ${item.name}`);
        }
        
        // 2. Insere o pedido no banco com status de TESTE
        const { data: order, error: orderError } = await supabase.from('orders').insert([{
            customer_name: customerInfo.name,
            customer_email: customerInfo.email,
            shipping_address: customerInfo.address,
            total,
            items: cart,
            user_id: userId || null,
            status: 'Pagamento Aprovado (TESTE)' // Status de Teste!
        }]).select().single();

        if (orderError) throw orderError;

        // 3. Retorna sucesso imediato (sem Mercado Pago)
        console.log(`>>> Pedido de TESTE #${order.id} criado com sucesso.`);
        res.json({ status: 'success' });

    } catch (error) {
        res.status(400).json({ status: 'error', message: error.message });
    }
});
// ===== FIM DA ROTA DE TESTE =====


// --- AUTENTICAÇÃO (CLIENTE E ADMIN) ---
app.post('/api/client/signup', async (req, res) => {
    const { email, password, name } = req.body;
    const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { full_name: name } } });
    if (error) return res.status(400).json({ error: error.message });
    if (data.session) res.json({ success: true, user: data.user, session: data.session });
    else res.json({ success: true, requireConfirmation: true });
});
app.post('/api/client/login', async (req, res) => {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: "Dados incorretos." });
    res.json({ success: true, user: data.user, session: data.session });
});
app.post('/api/admin/login', async (req, res) => {
    const { email, password } = req.body;
    if (email !== process.env.ADMIN_EMAIL) {
        return res.status(401).json({ success: false, error: "Credenciais inválidas." });
    }
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
        return res.status(401).json({ success: false, error: "Credenciais inválidas." });
    }
    res.json({ success: true, token: data.session.access_token });
});

// --- ROTAS DE ADMIN ---
app.get('/api/admin/dashboard', adminAuth, async (req, res) => { const { data: o } = await supabase.from('orders').select('total,status'); const { data: p } = await supabase.from('products').select('stock'); res.json({ totalRevenue: o?.reduce((s, i) => s + Number(i.total), 0) || 0, totalOrders: o?.length || 0, pendingOrders: o?.filter(x => x.status.includes('Aguardando') || x.status === 'Pendente').length || 0, lowStock: p?.filter(x => x.stock < 5).length || 0 }); });
app.post('/api/admin/products', adminAuth, async (req, res) => {
    const { data, error } = await supabase.from('products').insert([req.body]);
    if (error) {
        console.error("Erro ao salvar produto:", error);
        return res.status(500).json({ error: error.message });
    }
    res.json({ success: true });
});
app.delete('/api/admin/products/:id', adminAuth, async (req, res) => { await supabase.from('products').delete().eq('id', req.params.id); res.json({ success: true }); });
app.patch('/api/admin/products/:id/highlight', adminAuth, async (req, res) => { const { is_highlight } = req.body; await supabase.from('products').update({ is_highlight }).eq('id', req.params.id); res.json({ success: true }); });
app.patch('/api/admin/products/:id', adminAuth, async (req, res) => {
    const { id } = req.params;
    const { stock, image, description } = req.body;
    const { data, error } = await supabase
        .from('products')
        .update({
            stock: stock,
            image: image,
            description: description
        })
        .eq('id', id);
    if (error) {
        console.error("Erro ao atualizar produto:", error);
        return res.status(500).json({ error: error.message });
    }
    res.json({ success: true, data });
});
app.get('/api/admin/orders', adminAuth, async (req, res) => { const { data } = await supabase.from('orders').select('*').order('created_at', { ascending: false }); res.json(data); });
app.patch('/api/admin/orders/:id', adminAuth, async (req, res) => { await supabase.from('orders').update({ status: req.body.status }).eq('id', req.params.id); res.json({ success: true }); });
app.delete('/api/admin/orders/:id', adminAuth, async (req, res) => { await supabase.from('orders').delete().eq('id', req.params.id); res.json({ success: true }); });

app.listen(port, () => console.log(`SERVIDOR E SITE RODANDO EM: http://localhost:${port}`));