const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const stripe = require('stripe')('sk_test_51USDXL5NyRkEUITNcybTXdM7rs4pZacSIr7mFJoyeeYivoJyWWv7zXD78QHmWo1z5I0vrZTbQgTchvUaQ23QA2jf00MF27rW4k'); // Thay bằng Secret Key của Stripe

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const DUFFEL_API_TOKEN = process.env.DUFFEL_TOKEN || 'duffel_test_2iInettznX-PiY9qmpZMSrqeZBngaIMwX8upRdtEq9t';
const DUFFEL_BASE_URL = 'https://api.duffel.com/air';

// 1. API Tìm kiếm chuyến bay
app.post('/api/search-flights', async (req, res) => {
    const { from, to, departDate, passengers, returnDate, tripType } = req.body;
    try {
        const slices = [{ origin: from, destination: to, departure_date: departDate }];
        if (tripType === 'round' && returnDate) {
            slices.push({ origin: to, destination: from, departure_date: returnDate });
        }

        const duffelRes = await fetch(`${DUFFEL_BASE_URL}/offer_requests?return_offers=false`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${DUFFEL_API_TOKEN}`,
                'Duffel-Version': 'v2',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                data: {
                    slices: slices,
                    passengers: Array(parseInt(passengers || 1)).fill({ type: 'adult' }),
                    cabin_class: 'economy'
                }
            })
        });

        const data = await duffelRes.json();
        if (data.errors) return res.status(400).json({ error: data.errors[0].message });

        const offersRes = await fetch(`${DUFFEL_BASE_URL}/offers?offer_request_id=${data.data.id}`, {
            headers: { 'Authorization': `Bearer ${DUFFEL_API_TOKEN}`, 'Duffel-Version': 'v2' }
        });
        const offersData = await offersRes.json();
        res.json(offersData);
    } catch (error) {
        res.status(500).json({ error: 'Lỗi kết nối đến máy chủ Duffel' });
    }
});

// 2. API Tạo phiên thanh toán Stripe và lưu tạm thông tin vé
app.post('/api/create-checkout-session', async (req, res) => {
    const { offer, passengers } = req.body;
    try {
        const amount = Math.round(parseFloat(offer.total_amount));
        const currency = offer.total_currency.toLowerCase();

        // Tạo Stripe Checkout Session
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: currency,
                    product_data: {
                        name: `Vé máy bay: ${offer.slices[0].origin.iata_code} → ${offer.slices[0].destination.iata_code}`,
                        description: `Hãng: ${offer.owner.name} - Số lượng hành khách: ${passengers.length}`
                    },
                    unit_amount: amount,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `http://localhost:3000/success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `http://localhost:3000/index.html`,
            metadata: {
                offerId: offer.id,
                passengersData: JSON.stringify(passengers)
            }
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// 3. API Xác nhận thanh toán thành công và gọi Duffel xuất vé thực tế
app.post('/api/verify-and-book', async (req, res) => {
    const { sessionId } = req.body;
    try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.payment_status !== 'paid') {
            return res.status(400).json({ error: "Thanh toán chưa hoàn tất." });
        }

        const offerId = session.metadata.offerId;
        const passengers = JSON.parse(session.metadata.passengersData);

        // Gọi Duffel API để tạo Order (Xuất vé thật)
        const orderRes = await fetch(`${DUFFEL_BASE_URL}/orders`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${DUFFEL_API_TOKEN}`,
                'Duffel-Version': 'v2',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                data: {
                    selected_offers: [offerId],
                    passengers: passengers,
                    payments: [{
                        type: "balance",
                        amount: session.amount_total.toString(),
                        currency: session.currency.toUpperCase()
                    }]
                }
            })
        });

        const orderData = await orderRes.json();
        if (orderData.errors) {
            return res.status(400).json({ error: orderData.errors[0].message });
        }

        res.json({ success: true, booking_reference: orderData.data.booking_reference });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server đang chạy tại http://localhost:${PORT}`));