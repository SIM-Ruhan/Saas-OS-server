import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { parse as parseCsv } from 'csv-parse/sync';
import { unzipSync } from 'fflate';
import { MongoClient, ObjectId } from 'mongodb';
import Stripe from 'stripe';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';

const app = express();
app.disable('x-powered-by');
const env = process.env;
const clientUrl = (env.CLIENT_URL?.split(',')[0] || 'http://localhost:3000').replace(/\/$/, '');
const serverUrl = (env.SERVER_URL || 'http://localhost:8000').replace(/\/$/, '');
const dbName = env.MONGODB_DB || 'shopOS';
const client = env.MONGODB_URI ? new MongoClient(env.MONGODB_URI) : null;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3_500_000, files: 8, fields: 48, fieldSize: 400_000 },
});
const shopFiles = upload.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'bannerImage', maxCount: 1 },
  { name: 'image', maxCount: 1 },
  { name: 'images', maxCount: 5 },
]);
const currencies = ['BDT', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'SGD', 'INR', 'AED', 'MYR'];
const paypalCurrencies = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'SGD', 'MYR'];
const defaultPlans = {
  free: {
    name: 'Free',
    products: 20,
    pages: 1,
    seats: 1,
    bandwidth: 100_000_000,
    monthly: 0,
    yearly: 0,
    lifetime: 0,
  },
  starter: {
    name: 'Starter',
    products: 100,
    pages: 3,
    seats: 2,
    bandwidth: 1_000_000_000,
    monthly: 990,
    yearly: 9900,
    lifetime: 22900,
  },
  growth: {
    name: 'Growth',
    products: 1000,
    pages: 20,
    seats: 6,
    bandwidth: 10_000_000_000,
    monthly: 2490,
    yearly: 24900,
    lifetime: 54900,
  },
  scale: {
    name: 'Scale',
    products: 10000,
    pages: 100,
    seats: 25,
    bandwidth: 100_000_000_000,
    monthly: 4990,
    yearly: 49900,
    lifetime: 109900,
  },
};
const paymentMethods = ['cod', 'sslcommerz', 'bkash', 'stripe', 'paypal', 'aamarpay', 'shurjopay'];
const courierMethods = ['steadfast', 'pathao', 'redx', 'shippo'];
const roles = ['manager', 'support'];
const sectionTypes = ['hero', 'features', 'testimonials', 'countdown', 'faq', 'order'];
const campaignTypes = ['percent', 'fixed', 'flash', 'bundle'];
const today = () => new Date();
const days = (n) => n * 86_400_000;
const minor = (value) => Math.round(Number(value) * 100);
const money = (value) => Math.round(value) / 100;
const toId = (value) =>
  typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value) ? new ObjectId(value) : null;
const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const sign = (value, key = env.SHOPOS_PROXY_SECRET) =>
  createHmac('sha256', key).update(value).digest('hex');
const safeEqual = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const trim = (value, max = 250) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const lower = (value, max) => trim(value, max).toLowerCase();
const yes = (value, fallback = false) =>
  value === undefined ? fallback : value === true || value === 'true' || value === '1';
const slugify = (value) =>
  trim(value, 150)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 55);
const currency = (value, fallback = 'BDT') =>
  currencies.includes(String(value).toUpperCase()) ? String(value).toUpperCase() : fallback;
const email = (value) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lower(value, 254)) ? lower(value, 254) : '');
const serialize = (doc) => doc && { ...doc, id: String(doc._id), _id: undefined };
const headersNoStore = (res) => res.set('Cache-Control', 'private, no-store');
const isAdmin = (user) =>
  !!user &&
  (env.ADMIN_USER_IDS || '')
    .split(',')
    .map((item) => item.trim())
    .includes(user.id);

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
function assert(condition, status, message, code) {
  if (!condition) throw new HttpError(status, message, code);
}
function json(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new HttpError(400, 'Invalid JSON field');
  }
}
function number(value, name, min, max, integer = false) {
  const result = Number(value);
  assert(
    value !== '' &&
      value !== null &&
      Number.isFinite(result) &&
      result >= min &&
      result <= max &&
      (!integer || Number.isInteger(result)),
    400,
    `${name} must be between ${min} and ${max}`,
  );
  return result;
}
function webUrl(value, max = 1500) {
  if (!value) return '';
  let url;
  try {
    url = new URL(trim(value, max));
  } catch {
    throw new HttpError(400, 'Enter a valid HTTPS or HTTP URL');
  }
  assert(
    ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password,
    400,
    'Enter a valid HTTPS or HTTP URL',
  );
  return url.href;
}
function dateValue(value, fallback = null) {
  if (!value) return fallback;
  const parsed = new Date(value);
  assert(Number.isFinite(parsed.getTime()), 400, 'Invalid date');
  return parsed;
}
function pageLimit(req, fallback = 50, max = 200) {
  return {
    limit: Math.min(max, Math.max(1, Number.parseInt(req.query.limit, 10) || fallback)),
    skip: Math.min(10_000, Math.max(0, Number.parseInt(req.query.skip, 10) || 0)),
  };
}
function recordId(value) {
  const result = toId(value);
  assert(result, 400, 'Invalid record ID');
  return result;
}
function actor(req) {
  const payload = req.get('x-shopos-user');
  if (!payload || !env.SHOPOS_PROXY_SECRET || !safeEqual(req.get('x-shopos-signature'), sign(payload)))
    return null;
  try {
    const user = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const age = Date.now() - user.issuedAt;
    return typeof user.id === 'string' && age >= -5000 && age < 90_000 ? user : null;
  } catch {
    return null;
  }
}
function requireActor(req) {
  const user = actor(req);
  assert(user?.id, 401, 'Sign in to continue', 'SIGN_IN_REQUIRED');
  assert(!user.blocked, 403, 'This account is suspended');
  return user;
}
function requireAdmin(req) {
  const user = requireActor(req);
  assert(isAdmin(user), 403, 'Administrator access required');
  return user;
}
const route = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};
let ready;
async function db() {
  assert(client, 503, 'Configure the MongoDB connection');
  const database = client.db(dbName);
  ready ??= Promise.all([
    database.collection('shops').createIndex({ slug: 1 }, { unique: true }),
    database.collection('shops').createIndex({ ownerId: 1 }),
    database.collection('products').createIndex({ shopSlug: 1, active: 1, createdAt: -1 }),
    database
      .collection('products')
      .createIndex(
        { shopSlug: 1, skuKey: 1 },
        { unique: true, partialFilterExpression: { skuKey: { $type: 'string' } } },
      ),
    database.collection('storefrontUsage').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    database.collection('orders').createIndex({ shopSlug: 1, createdAt: -1 }),
    database
      .collection('orders')
      .createIndex(
        { shopSlug: 1, checkoutKey: 1 },
        { unique: true, partialFilterExpression: { checkoutKey: { $type: 'string' } } },
      ),
    database.collection('orders').createIndex({ checkoutSessionId: 1 }, { sparse: true }),
    database.collection('staff').createIndex({ shopSlug: 1, email: 1 }, { unique: true }),
    database.collection('landings').createIndex({ shopSlug: 1, slug: 1 }, { unique: true }),
    database.collection('domains').createIndex({ host: 1 }, { unique: true }),
    database.collection('discounts').createIndex({ shopSlug: 1, code: 1 }, { unique: true }),
    database.collection('affiliates').createIndex({ shopSlug: 1, code: 1 }, { unique: true }),
    database.collection('events').createIndex({ shopSlug: 1, eventId: 1 }, { unique: true }),
    database.collection('events').createIndex({ shopSlug: 1, createdAt: -1 }),
    database.collection('jobs').createIndex({ state: 1, dueAt: 1 }),
    database
      .collection('reviews')
      .createIndex({ shopSlug: 1, productId: 1, orderId: 1 }, { unique: true }),
    database.collection('abandoned').createIndex({ shopSlug: 1, visitor: 1 }, { unique: true }),
    database.collection('abandoned').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    database.collection('tickets').createIndex({ shopSlug: 1, updatedAt: -1 }),
    database.collection('providers').createIndex({ shopSlug: 1 }, { unique: true }),
    database.collection('research').createIndex({ shopSlug: 1, capturedAt: -1 }),
  ]).catch((error) => {
    ready = null;
    throw error;
  });
  await ready;
  return database;
}
async function transaction(operation) {
  const database = await db();
  return client.withSession((session) => session.withTransaction(() => operation(database, session)));
}
async function audit(database, shopSlug, userId, action, target = '', session) {
  await database
    .collection('audit')
    .insertOne({ shopSlug, userId, action, target, createdAt: today() }, { session });
}
async function notice(database, shopSlug, type, title, detail, session) {
  await database
    .collection('notifications')
    .insertOne({ shopSlug, type, title, detail, createdAt: today() }, { session });
}
async function queue(database, shopSlug, type, payload, dueAt = today(), session) {
  await database
    .collection('jobs')
    .insertOne(
      { shopSlug, type, payload, dueAt, state: 'pending', attempts: 0, createdAt: today() },
      { session },
    );
}
async function findShop(database, slug, publicOnly = false) {
  const shop = await database.collection('shops').findOne({ slug });
  assert(
    shop && (!publicOnly || !['suspended', 'pending'].includes(shop.status)),
    404,
    'Shop not found',
  );
  return shop;
}
async function workspace(req, permission = 'read') {
  const user = requireActor(req);
  const database = await db();
  const shop = await findShop(database, req.params.slug);
  const membership =
    user.email && user.emailVerified
      ? await database
          .collection('staff')
          .findOne({ shopSlug: shop.slug, email: lower(user.email), active: true })
      : null;
  const role = shop.ownerId === user.id ? 'owner' : membership?.role;
  const permitted =
    permission === 'read' ||
    (permission === 'orders' && roles.includes(role)) ||
    (permission === 'manage' && role === 'manager') ||
    role === 'owner';
  assert(role && permitted, 403, 'You do not have access to this shop');
  assert(shop.status !== 'suspended' || permission === 'read', 403, 'This shop is suspended');
  return { user, database, shop, role };
}
function publicShop(shop) {
  const {
    _id,
    slug,
    name,
    description,
    logoUrl,
    banners,
    categories,
    staticSections,
    footer,
    country,
    language,
    timezone,
    rates,
    seo,
    whatsapp,
    codEnabled,
    shipping,
    collections,
    theme,
  } = shop;
  return {
    id: String(_id),
    slug,
    name,
    description,
    logoUrl,
    banners: banners || [],
    categories: categories || [],
    staticSections: staticSections || [],
    footer: footer || {},
    currency: currency(shop.currency),
    country: country || 'BD',
    language: language || 'en',
    timezone: timezone || 'Asia/Dhaka',
    rates: rates || {},
    seo: seo || {},
    whatsapp,
    codEnabled: codEnabled !== false,
    shipping: (shipping || []).map(({ id, label, country, base, perKg, postalPrefix }) => ({
      id,
      label,
      country,
      base,
      perKg,
      postalPrefix,
    })),
    collections: collections || [],
    theme,
  };
}
async function plans(database) {
  const overrides = await database.collection('platform').findOne({ _id: 'plans' });
  return Object.fromEntries(
    Object.entries(defaultPlans).map(([key, value]) => [key, { ...value, ...overrides?.values?.[key] }]),
  );
}
function effectivePlan(shop) {
  if (
    shop.billing?.status === 'lifetime' ||
    (['active', 'trialing'].includes(shop.billing?.status) &&
      (!shop.billing.endsAt || new Date(shop.billing.endsAt) > today()))
  )
    return shop.billing.plan || 'starter';
  if (shop.trialEndsAt && new Date(shop.trialEndsAt) > today()) return 'starter';
  return 'free';
}
async function capacity(database, shop, key, increment, session) {
  const plan = (await plans(database))[effectivePlan(shop)] || defaultPlans.free;
  const collection = { products: 'products', pages: 'landings', seats: 'staff' }[key];
  const filter = key === 'seats' ? { shopSlug: shop.slug, active: true } : { shopSlug: shop.slug };
  if (session)
    await database
      .collection('shops')
      .updateOne({ _id: shop._id }, { $inc: { quotaVersion: 1 } }, { session });
  const used =
    (await database.collection(collection).countDocuments(filter, { session })) +
    (key === 'seats' ? 1 : 0);
  assert(
    used + increment <= plan[key],
    409,
    `Your ${plan.name} plan allows ${plan[key]} ${key}. Open Billing to change your plan.`,
    'PLAN_LIMIT',
  );
}
function transferKey(shop) {
  return `${shop._id}:${today().toISOString().slice(0, 7)}`;
}
async function storefrontResponse(database, shop, req, res, data, contentType = 'application/json') {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  if (req.method !== 'HEAD') {
    const bytes = Buffer.byteLength(body);
    const plan = (await plans(database))[effectivePlan(shop)] || defaultPlans.free;
    const usage = database.collection('storefrontUsage');
    const _id = transferKey(shop);
    await usage.updateOne(
      { _id },
      { $setOnInsert: { bytes: 0, expiresAt: new Date(Date.now() + days(95)) } },
      { upsert: true },
    );
    const reserved = await usage.updateOne(
      { _id, bytes: { $lte: plan.bandwidth - bytes } },
      { $inc: { bytes } },
    );
    assert(
      reserved.matchedCount,
      429,
      'This shop has reached its monthly storefront data limit.',
      'STOREFRONT_TRANSFER_LIMIT',
    );
  }
  return res.type(contentType).send(body);
}

app.use(
  cors({
    origin: (env.CORS_ORIGINS || env.CLIENT_URL || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    credentials: true,
  }),
);
app.post(
  ['/payments/stripe/webhook', '/payments/stripe/webhook/:slug'],
  express.raw({ type: 'application/json', limit: '1mb' }),
  route(stripeWebhook),
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.get(['/health', '/api/health'], (_req, res) => res.json({ status: 'ok' }));
app.get(
  '/me',
  route(async (req, res) => {
    const user = requireActor(req);
    headersNoStore(res).json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      admin: isAdmin(user),
    });
  }),
);
app.get(
  '/plans',
  route(async (_req, res) => res.json({ ...(await plans(await db())), currency: billingCurrency() })),
);
app.get(
  '/shops',
  route(async (req, res) => {
    const { limit, skip } = pageLimit(req, 48);
    const shops = await (
      await db()
    )
      .collection('shops')
      .find({ status: { $nin: ['pending', 'suspended'] } })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();
    res.json(shops.map(publicShop));
  }),
);
app.get(
  '/my/shops',
  route(async (req, res) => {
    const user = requireActor(req);
    const database = await db();
    const memberships = user.emailVerified
      ? await database
          .collection('staff')
          .find({ email: lower(user.email), active: true })
          .toArray()
      : [];
    const shops = await database
      .collection('shops')
      .find({ $or: [{ ownerId: user.id }, { slug: { $in: memberships.map((item) => item.shopSlug) } }] })
      .sort({ createdAt: -1 })
      .toArray();
    headersNoStore(res).json(
      shops.map((shop) => ({
        ...publicShop(shop),
        role:
          shop.ownerId === user.id
            ? 'owner'
            : memberships.find((item) => item.shopSlug === shop.slug)?.role,
        plan: effectivePlan(shop),
        status: shop.status || 'active',
      })),
    );
  }),
);
app.post(
  '/shops',
  shopFiles,
  route(async (req, res) => {
    const user = requireActor(req);
    assert(
      user.role === 'seller' || isAdmin(user),
      403,
      'Activate your seller account to create a shop',
      'SELLER_REQUIRED',
    );
    const name = trim(req.body.name, 100);
    const slug = slugify(req.body.slug || name);
    assert(
      name.length >= 2 && /^[a-z0-9][a-z0-9-]{1,54}$/.test(slug),
      400,
      'Enter a shop name and a valid URL slug',
    );
    assert(
      !['www', 'admin', 'api', 'dashboard', 'localhost'].includes(slug),
      400,
      'Choose another shop slug',
    );
    const trial = Math.min(60, Math.max(0, Number(env.TRIAL_DAYS ?? 14) || 0));
    const shop = {
      name,
      slug,
      ownerId: user.id,
      ownerEmail: user.email,
      description: trim(req.body.description, 1500),
      logoUrl: req.files?.logo?.[0] ? await uploadImage(req.files.logo[0]) : webUrl(req.body.logoUrl),
      currency: currency(req.body.currency),
      country: (trim(req.body.country, 2) || 'BD').toUpperCase(),
      timezone: trim(req.body.timezone, 80) || 'Asia/Dhaka',
      language: ['en', 'bn'].includes(req.body.language) ? req.body.language : 'en',
      banners: [],
      categories: [],
      collections: [],
      staticSections: [],
      footer: {},
      rates: {},
      shipping: [],
      codEnabled: true,
      status: env.REQUIRE_SELLER_APPROVAL === 'true' ? 'pending' : 'active',
      createdAt: today(),
      trialEndsAt: trial ? new Date(Date.now() + days(trial)) : null,
    };
    if (req.body.bannerHeading || req.files?.bannerImage?.[0])
      shop.banners.push({
        id: randomUUID(),
        heading: trim(req.body.bannerHeading, 150),
        description: trim(req.body.bannerDescription, 1000),
        imageUrl: req.files?.bannerImage?.[0] ? await uploadImage(req.files.bannerImage[0]) : '',
      });
    const database = await db();
    await database.collection('shops').insertOne(shop);
    await audit(database, slug, user.id, 'shop.created', slug);
    res.status(201).json({ ...publicShop(shop), status: shop.status });
  }),
);
app.get(
  '/shops/:slug',
  route(async (req, res) => {
    const database = await db();
    const shop = await findShop(database, req.params.slug, true);
    const cfg = await providerConfig(database, shop.slug);
    await storefrontResponse(database, shop, req, res, {
      ...publicShop(shop),
      payments: availablePayments(shop, cfg),
      tracking: publicTracking(cfg),
      orderMessaging: {
        email: providerReady('email', cfg.email) || !!(env.RESEND_API_KEY && env.EMAIL_FROM),
        sms: providerReady('sms', cfg.sms) && !!cfg.sms.from,
        whatsapp: providerReady('sms', cfg.sms) && !!cfg.sms.whatsappFrom,
      },
      pathao: shop.autoCourier === 'pathao' && providerReady('pathao', cfg.pathao),
    });
  }),
);

async function uploadImage(file, name = file?.originalname) {
  assert(file?.buffer, 400, 'Choose an image file');
  const bytes = file.buffer;
  const isImage =
    (bytes[0] === 0xff && bytes[1] === 0xd8) ||
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString('ascii', 0, 3) === 'GIF' ||
    bytes.toString('ascii', 8, 12) === 'WEBP';
  assert(isImage && bytes.length <= 3_500_000, 400, 'Upload a JPEG, PNG, GIF or WebP under 3.5 MB');
  assert(env.IMGBB_API_KEY, 503, 'Set IMGBB_API_KEY to upload files, or enter an image URL');
  const result = await requestJson(
    'https://api.imgbb.com/1/upload',
    {
      method: 'POST',
      body: new URLSearchParams({
        key: env.IMGBB_API_KEY,
        image: bytes.toString('base64'),
        name: slugify(name) || 'product',
      }),
    },
    'Image upload',
  );
  assert(result.data?.url, 502, 'Image upload did not return a URL');
  return webUrl(result.data.url);
}
function sectionInput(input, previous = {}) {
  const next = { ...previous };
  for (const key of ['name', 'heading', 'description', 'ctaText', 'imagePosition'])
    if (input[key] !== undefined) next[key] = trim(input[key], key === 'description' ? 1600 : 180);
  if (input.ctaLink !== undefined)
    next.ctaLink =
      input.ctaLink?.startsWith('/') && !input.ctaLink.startsWith('//')
        ? trim(input.ctaLink, 500)
        : webUrl(input.ctaLink);
  if (input.imageUrl !== undefined) next.imageUrl = webUrl(input.imageUrl);
  return next;
}
for (const kind of ['categories', 'static-sections', 'banners']) {
  const field = kind === 'static-sections' ? 'staticSections' : kind;
  const save = route(async (req, res) => {
    const { database, shop } = await workspace(req, 'manage');
    const items = shop[field] || [];
    const current = req.params.itemId && items.find((item) => item.id === req.params.itemId);
    assert(!req.params.itemId || current, 404, 'Item not found');
    assert(current || items.length < 100, 409, 'This section has reached its item limit');
    const next = sectionInput(req.body, current || { id: randomUUID() });
    const file = req.files?.image?.[0] || req.files?.bannerImage?.[0];
    if (file) next.imageUrl = await uploadImage(file);
    if (kind === 'categories') assert(next.name, 400, 'Category name is required');
    const filter = current ? { [`${field}.id`]: next.id } : { [`${field}.99`]: { $exists: false } };
    const update = current ? { $set: { [`${field}.$`]: next } } : { $push: { [field]: next } };
    const updated = await database
      .collection('shops')
      .findOneAndUpdate({ _id: shop._id, ...filter }, update, { returnDocument: 'after' });
    assert(updated, 409, 'Storefront content changed. Refresh before trying again.');
    res.status(current ? 200 : 201).json(kind === 'banners' ? updated.banners : next);
  });
  app.post(`/shops/:slug/${kind}`, shopFiles, save);
  app.put(`/shops/:slug/${kind}/:itemId`, shopFiles, save);
  app.patch(`/shops/:slug/${kind}/:itemId`, shopFiles, save);
  app.delete(
    `/shops/:slug/${kind}/:itemId`,
    route(async (req, res) => {
      const { database, shop } = await workspace(req, 'manage');
      const result = await database
        .collection('shops')
        .findOneAndUpdate(
          { _id: shop._id },
          { $pull: { [field]: { id: req.params.itemId } } },
          { returnDocument: 'after' },
        );
      res.json(kind === 'banners' ? result.banners || [] : { ok: true });
    }),
  );
}
app.put(
  '/shops/:slug/footer',
  route(async (req, res) => {
    const { database, shop } = await workspace(req, 'manage');
    const footer = {
      about: trim(req.body.about, 1000),
      email: email(req.body.email),
      phone: trim(req.body.phone, 30),
      address: trim(req.body.address, 300),
      socials: {},
    };
    for (const key of ['facebook', 'instagram', 'whatsapp'])
      if (req.body.socials?.[key]) footer.socials[key] = webUrl(req.body.socials[key]);
    await database.collection('shops').updateOne({ _id: shop._id }, { $set: { footer } });
    res.json(footer);
  }),
);

function productInput(input, old = {}) {
  const merged = { ...old, ...input };
  const name = trim(merged.name || merged.title, 160);
  assert(name, 400, 'Product name is required');
  const price = money(minor(number(merged.price, 'Price', 0, 999_999)));
  const stock = number(merged.stock ?? 0, 'Stock', 0, 100_000, true);
  const imageUrl = webUrl(merged.imageUrl);
  const rawImages = json(merged.images, []);
  assert(Array.isArray(rawImages) && rawImages.length <= 8, 400, 'Use up to eight image URLs');
  const images = [
    ...new Set([imageUrl, ...rawImages.map((item) => webUrl(item))].filter(Boolean)),
  ].slice(0, 8);
  const attributes = json(merged.attributes, []);
  const variants = json(merged.variants, []);
  assert(
    Array.isArray(attributes) &&
      attributes.length <= 12 &&
      Array.isArray(variants) &&
      variants.length <= 80,
    400,
    'Use up to 12 attributes and 80 variants',
  );
  const cleanAttributes = attributes
    .map((entry) => ({
      name: trim(entry?.name, 40),
      type: ['text', 'select', 'swatch'].includes(entry?.type) ? entry.type : 'text',
      values: (Array.isArray(entry?.values) ? entry.values : String(entry?.values || '').split(','))
        .map((value) => trim(value, 60))
        .filter(Boolean)
        .slice(0, 30),
    }))
    .filter((entry) => entry.name);
  const cleanVariants = variants.map((entry) => ({
    id: /^[a-z0-9-]{1,60}$/i.test(entry?.id || '') ? entry.id : randomUUID(),
    name: trim(entry?.name, 100),
    sku: trim(entry?.sku, 80),
    price: money(minor(number(entry?.price ?? price, 'Variant price', 0, 999_999))),
    stock: number(entry?.stock ?? 0, 'Variant stock', 0, 100_000, true),
    imageUrl: webUrl(entry?.imageUrl),
    options: Object.fromEntries(
      Object.entries(entry?.options || {})
        .slice(0, 12)
        .filter(([key]) => /^[\p{L}\p{N} _-]{1,40}$/u.test(key))
        .map(([key, value]) => [key, trim(value, 60)]),
    ),
  }));
  assert(
    cleanVariants.every((entry) => entry.name) &&
      new Set(cleanVariants.map((entry) => entry.id)).size === cleanVariants.length,
    400,
    'Give each variant a name and a unique ID',
  );
  return {
    name,
    description: trim(merged.description, 5000),
    price,
    stock,
    sku: trim(merged.sku, 80),
    category: trim(merged.category, 100),
    imageUrl: images[0] || '',
    images,
    videoUrl: webUrl(merged.videoUrl),
    tags: (Array.isArray(merged.tags) ? merged.tags : String(merged.tags || '').split(','))
      .map((value) => trim(value, 35))
      .filter(Boolean)
      .slice(0, 20),
    weight: number(merged.weight || 0, 'Weight (kg)', 0, 1000),
    material: trim(merged.material, 100),
    active: yes(merged.active, true),
    lowStock: number(merged.lowStock ?? 5, 'Low stock threshold', 0, 100_000, true),
    backorder: yes(merged.backorder),
    codEnabled: yes(merged.codEnabled, true),
    attributes: cleanAttributes,
    variants: cleanVariants,
    seoTitle: trim(merged.seoTitle, 70),
    seoDescription: trim(merged.seoDescription, 180),
    updatedAt: today(),
  };
}
function publicProduct(product) {
  const clean = serialize(product);
  delete clean.moderationNote;
  delete clean.skuKey;
  return clean;
}
app.get(
  '/shops/:slug/products',
  route(async (req, res) => {
    const database = await db();
    const filter = { shopSlug: req.params.slug };
    let shop;
    if (req.query.all === '1') await workspace(req);
    else {
      shop = await findShop(database, req.params.slug, true);
      filter.active = { $ne: false };
      filter.moderation = { $ne: 'hidden' };
    }
    const q = trim(req.query.q, 100);
    if (q) filter.name = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (req.query.category) filter.category = trim(req.query.category, 100);
    const { skip, limit } = pageLimit(req, 60, 300);
    const products = await database
      .collection('products')
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();
    if (!shop) return headersNoStore(res).json(products.map(serialize));
    await storefrontResponse(database, shop, req, res, products.map(publicProduct));
  }),
);
async function assignSku(database, product, shopSlug, session, currentId) {
  if (product.sku) {
    const existing = await database
      .collection('products')
      .findOne(
        { shopSlug, sku: product.sku, ...(currentId ? { _id: { $ne: currentId } } : {}) },
        { session },
      );
    assert(!existing, 409, `SKU ${product.sku} already exists`);
  }
  // Legacy duplicate SKUs remain editable. Enforce uniqueness on new or changed SKUs.
  product.skuKey = product.sku || null;
}
async function attachProductImages(req, item) {
  const files = [...(req.files?.image || []), ...(req.files?.images || [])];
  if (!files.length) return item;
  const urls = [];
  for (const file of files) urls.push(await uploadImage(file));
  item.images = [...new Set([...urls, ...item.images])].slice(0, 8);
  item.imageUrl = item.images[0];
  return item;
}
app.post(
  '/shops/:slug/products',
  shopFiles,
  route(async (req, res) => {
    const { user, shop } = await workspace(req, 'manage');
    const product = await attachProductImages(req, {
      ...productInput(req.body),
      shopSlug: shop.slug,
      createdAt: today(),
    });
    await transaction(async (database, session) => {
      await capacity(database, shop, 'products', 1, session);
      await assignSku(database, product, shop.slug, session);
      await database.collection('products').insertOne(product, { session });
      await audit(database, shop.slug, user.id, 'product.created', String(product._id), session);
      await enqueueWebhooks(
        database,
        shop.slug,
        'product.updated',
        { id: String(product._id), action: 'created' },
        session,
      );
    });
    res.status(201).json(serialize(product));
  }),
);
app.put(
  '/shops/:slug/products/:productId',
  shopFiles,
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req, 'manage');
    const filter = { _id: recordId(req.params.productId), shopSlug: shop.slug };
    const previous = await database.collection('products').findOne(filter);
    assert(previous, 404, 'Product not found');
    const updated = await attachProductImages(req, productInput(req.body, previous));
    await transaction(async (database, session) => {
      if (updated.sku !== (previous.sku || ''))
        await assignSku(database, updated, shop.slug, session, filter._id);
      const removed = (previous.variants || []).filter(
        (item) => !updated.variants.some((variant) => variant.id === item.id),
      );
      if (removed.length)
        assert(
          !(await database.collection('orders').findOne(
            {
              shopSlug: shop.slug,
              items: {
                $elemMatch: {
                  productId: filter._id,
                  variantId: { $in: removed.map((item) => item.id) },
                },
              },
              status: { $nin: ['cancelled', 'returned'] },
            },
            { session },
          )),
          409,
          'Retain variants linked to orders so returns can restore their stock',
        );
      const result = await database
        .collection('products')
        .updateOne(
          { ...filter, updatedAt: previous.updatedAt ?? { $exists: false } },
          { $set: updated },
          { session },
        );
      assert(
        result.matchedCount,
        409,
        'The product changed while you were editing. Reload and try again.',
      );
      await audit(database, shop.slug, user.id, 'product.updated', req.params.productId, session);
      await enqueueWebhooks(
        database,
        shop.slug,
        'product.updated',
        { id: req.params.productId, action: 'updated' },
        session,
      );
    });
    res.json({ ...serialize(previous), ...updated });
  }),
);
app.delete(
  '/shops/:slug/products/:productId',
  route(async (req, res) => {
    const { shop, user } = await workspace(req, 'manage');
    const productId = recordId(req.params.productId);
    await transaction(async (database, session) => {
      const pending = await database.collection('orders').countDocuments(
        {
          shopSlug: shop.slug,
          'items.productId': productId,
          status: { $nin: ['delivered', 'cancelled', 'returned'] },
        },
        { session },
      );
      assert(!pending, 409, 'Archive the product while there are open orders');
      const result = await database
        .collection('products')
        .deleteOne({ _id: productId, shopSlug: shop.slug }, { session });
      assert(result.deletedCount, 404, 'Product not found');
      await audit(database, shop.slug, user.id, 'product.deleted', req.params.productId, session);
    });
    res.json({ ok: true });
  }),
);
app.post(
  '/shops/:slug/products/bulk',
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req, 'manage');
    const ids = req.body.ids;
    assert(Array.isArray(ids) && ids.length && ids.length <= 100, 400, 'Select up to 100 products');
    const set = { updatedAt: today() };
    if (req.body.price !== undefined && req.body.price !== '')
      set.price = money(minor(number(req.body.price, 'Price', 0, 999_999)));
    if (req.body.stock !== undefined && req.body.stock !== '')
      set.stock = number(req.body.stock, 'Stock', 0, 100_000, true);
    if (req.body.category !== undefined) set.category = trim(req.body.category, 100);
    if (req.body.active !== undefined) set.active = yes(req.body.active);
    const result = await database
      .collection('products')
      .updateMany({ _id: { $in: ids.map(recordId) }, shopSlug: shop.slug }, { $set: set });
    await audit(database, shop.slug, user.id, 'product.bulk_updated', String(result.modifiedCount));
    res.json({ updated: result.modifiedCount });
  }),
);
const csvFields = [
  'name',
  'description',
  'price',
  'stock',
  'sku',
  'category',
  'imageUrl',
  'active',
  'tags',
  'videoUrl',
  'weight',
  'lowStock',
  'backorder',
  'codEnabled',
  'seoTitle',
  'seoDescription',
];
function csvCell(value) {
  return `"${String(value ?? '')
    .replace(/^[=+@\-\t\r]/, (letter) => `'${letter}`)
    .replaceAll('"', '""')}"`;
}
app.get(
  '/shops/:slug/products/export',
  route(async (req, res) => {
    const { database, shop } = await workspace(req);
    const products = await database
      .collection('products')
      .find({ shopSlug: shop.slug })
      .limit(10_000)
      .toArray();
    res
      .type('text/csv')
      .attachment('products.csv')
      .send(
        [
          csvFields.join(','),
          ...products.map((item) => csvFields.map((field) => csvCell(item[field])).join(',')),
        ].join('\n'),
      );
  }),
);
app.post(
  '/shops/:slug/products/import',
  upload.single('file'),
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req, 'manage');
    assert(req.file && /\.csv$/i.test(req.file.originalname), 400, 'Choose a CSV file');
    const mapping = json(req.body?.mapping, {});
    let headers = [];
    let rows;
    try {
      rows = parseCsv(req.file.buffer, {
        columns: (fields) => (headers = fields.map((field) => field.trim())),
        skip_empty_lines: true,
        bom: true,
        max_record_size: 32_000,
      });
    } catch (error) {
      throw new HttpError(400, `Could not read CSV: ${trim(error.message, 250)}`);
    }
    assert(rows.length <= 500, 400, 'Import up to 500 rows at a time');
    const errors = [];
    const items = [];
    const seen = new Set();
    const existing = new Set(
      (await database.collection('products').distinct('sku', { shopSlug: shop.slug })).filter(Boolean),
    );
    for (const [index, row] of rows.entries()) {
      try {
        const normalized = Object.fromEntries(
          csvFields.map((field) => [field, row[mapping[field] || field] || undefined]),
        );
        const item = productInput(normalized);
        assert(
          !item.sku || (!seen.has(item.sku) && !existing.has(item.sku)),
          400,
          `SKU ${item.sku} already exists`,
        );
        seen.add(item.sku);
        items.push({ ...item, skuKey: item.sku || null, shopSlug: shop.slug, createdAt: today() });
      } catch (error) {
        errors.push({ row: index + 2, error: error.message });
      }
    }
    if (req.query.preview === '1')
      return res.json({ headers, valid: items.length, errors, sample: items.slice(0, 8) });
    assert(items.length && !errors.length, 400, 'Preview and fix invalid rows before importing');
    await transaction(async (database, session) => {
      await capacity(database, shop, 'products', items.length, session);
      await database.collection('products').insertMany(items, { session });
      await audit(database, shop.slug, user.id, 'product.imported', String(items.length), session);
    });
    res.status(201).json({ imported: items.length });
  }),
);
app.post(
  '/shops/:slug/products/images',
  upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'images', maxCount: 8 },
  ]),
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req, 'manage');
    const archive = req.files?.file?.[0];
    const files = req.files?.images || [];
    assert(
      !archive || (/\.zip$/i.test(archive.originalname) && !files.length),
      400,
      'Choose a ZIP of images named by SKU',
    );
    const imageExtension = /\.(png|jpe?g|webp|gif)$/i;
    const entries = [];
    if (archive) {
      let size = 0;
      let count = 0;
      try {
        const extracted = unzipSync(archive.buffer, {
          filter(entry) {
            count++;
            if (count > 120 || entry.originalSize > 3_500_000) throw new Error('ZIP is too large');
            if (!imageExtension.test(entry.name) || entry.name.includes('__MACOSX')) return false;
            size += entry.originalSize;
            if (size > 20_000_000) throw new Error('ZIP is too large');
            return true;
          },
        });
        for (const [path, bytes] of Object.entries(extracted)) {
          entries.push({
            sku: path.split('/').at(-1).replace(imageExtension, ''),
            buffer: Buffer.from(bytes),
          });
        }
      } catch {
        throw new HttpError(
          400,
          'Use a ZIP containing up to 120 entries and 20 MB of uncompressed images',
        );
      }
    } else {
      for (const file of files.filter((file) => imageExtension.test(file.originalname))) {
        entries.push({ sku: file.originalname.replace(imageExtension, ''), buffer: file.buffer });
      }
    }
    assert(entries.length, 400, 'No supported images were found');
    const updates = [],
      unmatched = [],
      failed = [];
    for (const entry of entries) {
      const matches = await database
        .collection('products')
        .find({ shopSlug: shop.slug, sku: entry.sku })
        .limit(2)
        .toArray();
      if (!matches.length) {
        unmatched.push(entry.sku);
        continue;
      }
      if (matches.length > 1) {
        failed.push({
          sku: entry.sku,
          error: 'Multiple products use this SKU. Assign a unique SKU first.',
        });
        continue;
      }
      const [product] = matches;
      try {
        const imageUrl = await uploadImage(entry, entry.sku);
        const attached = await database.collection('products').updateOne(
          { _id: product._id, updatedAt: product.updatedAt ?? { $exists: false } },
          {
            $set: {
              imageUrl,
              images: [...new Set([imageUrl, ...(product.images || [])])].slice(0, 8),
              updatedAt: today(),
            },
          },
        );
        assert(attached.matchedCount, 409, 'The product changed during upload. Reload before retrying.');
        updates.push(entry.sku);
      } catch (error) {
        failed.push({ sku: entry.sku, error: error.message });
      }
    }
    await audit(database, shop.slug, user.id, 'product.images_imported', String(updates.length));
    res.json({ updated: updates, unmatched, failed });
  }),
);
app.get(
  '/shops/:slug/products/:productId',
  route(async (req, res) => {
    const database = await db();
    const filter = { _id: recordId(req.params.productId), shopSlug: req.params.slug };
    let shop;
    if (req.query.all === '1') await workspace(req);
    else {
      shop = await findShop(database, req.params.slug, true);
      filter.active = { $ne: false };
      filter.moderation = { $ne: 'hidden' };
    }
    const item = await database.collection('products').findOne(filter);
    assert(item, 404, 'Product not found');
    if (!shop) return headersNoStore(res).json(serialize(item));
    await storefrontResponse(database, shop, req, res, publicProduct(item));
  }),
);

// Provider secrets are scoped to a store and encrypted before storage.
const providerFields = {
  sslcommerz: ['storeId', 'storePassword', 'sandbox'],
  stripe: ['accountId', 'secretKey', 'webhookSecret'],
  paypal: ['clientId', 'clientSecret', 'sandbox'],
  aamarpay: ['storeId', 'signature', 'sandbox'],
  bkash: ['appKey', 'appSecret', 'username', 'password', 'sandbox'],
  shurjopay: ['username', 'password', 'prefix', 'sandbox'],
  steadfast: ['apiKey', 'secretKey'],
  pathao: ['clientId', 'clientSecret', 'username', 'password', 'storeId', 'sandbox'],
  shippo: ['token'],
  redx: ['token', 'storeId', 'sandbox'],
  meta: ['pixelId', 'token', 'testCode'],
  tiktok: ['pixelId', 'token', 'testCode'],
  google: ['measurementId', 'endpoint', 'apiSecret'],
  email: ['apiKey', 'from'],
  sms: ['accountSid', 'authToken', 'from', 'whatsappFrom'],
  market: ['endpoint', 'token'],
};
const secretFields = new Set([
  'storePassword',
  'secretKey',
  'webhookSecret',
  'clientSecret',
  'signature',
  'apiKey',
  'password',
  'token',
  'apiSecret',
  'authToken',
  'appSecret',
  'appKey',
]);
function encryptionKey() {
  assert(
    env.INTEGRATION_ENCRYPTION_KEY,
    503,
    'Set INTEGRATION_ENCRYPTION_KEY on the server to save provider credentials',
  );
  return createHash('sha256').update(env.INTEGRATION_ENCRYPTION_KEY).digest();
}
function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((buffer) => buffer.toString('base64url')).join('.');
}
function decrypt(value) {
  const [iv, tag, ciphertext] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
}
async function providerConfig(database, slug) {
  const doc = await database.collection('providers').findOne({ shopSlug: slug });
  const own = doc?.sealed ? decrypt(doc.sealed) : {};
  const stripeConnect = !!own.stripe?.accountId;
  const allowShared = env.ALLOW_PLATFORM_PROVIDER_FALLBACK === 'true';
  const defaults = allowShared
    ? {
        sslcommerz: {
          storeId: env.SSLCOMMERZ_STORE_ID,
          storePassword: env.SSLCOMMERZ_STORE_PASSWORD,
          sandbox: env.SSLCOMMERZ_SANDBOX !== 'false',
        },
        stripe: { secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET },
        paypal: {
          clientId: env.PAYPAL_CLIENT_ID,
          clientSecret: env.PAYPAL_CLIENT_SECRET,
          sandbox: env.PAYPAL_SANDBOX !== 'false',
        },
        aamarpay: {
          storeId: env.AAMARPAY_STORE_ID,
          signature: env.AAMARPAY_SIGNATURE,
          sandbox: env.AAMARPAY_SANDBOX !== 'false',
        },
        bkash: {
          appKey: env.BKASH_APP_KEY,
          appSecret: env.BKASH_APP_SECRET,
          username: env.BKASH_USERNAME,
          password: env.BKASH_PASSWORD,
          sandbox: env.BKASH_SANDBOX !== 'false',
        },
        shurjopay: {
          username: env.SHURJOPAY_USERNAME,
          password: env.SHURJOPAY_PASSWORD,
          prefix: env.SHURJOPAY_PREFIX,
          sandbox: env.SHURJOPAY_SANDBOX !== 'false',
        },
        redx: {
          token: env.REDX_TOKEN,
          storeId: env.REDX_PICKUP_STORE_ID,
          sandbox: env.REDX_SANDBOX !== 'false',
        },
        steadfast: { apiKey: env.STEADFAST_API_KEY, secretKey: env.STEADFAST_SECRET_KEY },
        pathao: {
          clientId: env.PATHAO_CLIENT_ID,
          clientSecret: env.PATHAO_CLIENT_SECRET,
          username: env.PATHAO_USERNAME,
          password: env.PATHAO_PASSWORD,
          storeId: env.PATHAO_STORE_ID,
          sandbox: env.PATHAO_SANDBOX !== 'false',
        },
        shippo: { token: env.SHIPPO_TOKEN },
      }
    : {};
  return {
    ...defaults,
    ...own,
    stripe: stripeConnect
      ? {
          ...own.stripe,
          secretKey: env.STRIPE_SECRET_KEY,
          webhookSecret: env.STRIPE_CONNECT_WEBHOOK_SECRET,
        }
      : own.stripe || defaults.stripe,
  };
}
function providerReady(name, config) {
  if (!config || config.enabled === false) return false;
  const keys = {
    sslcommerz: ['storeId', 'storePassword'],
    stripe: ['secretKey', 'webhookSecret'],
    paypal: ['clientId', 'clientSecret'],
    aamarpay: ['storeId', 'signature'],
    bkash: ['appKey', 'appSecret', 'username', 'password'],
    shurjopay: ['username', 'password', 'prefix'],
    redx: ['token', 'storeId'],
    steadfast: ['apiKey', 'secretKey'],
    pathao: ['clientId', 'clientSecret', 'username', 'password', 'storeId'],
    shippo: ['token'],
    meta: ['pixelId', 'token'],
    tiktok: ['pixelId', 'token'],
    google: ['endpoint', 'measurementId', 'apiSecret'],
    email: ['apiKey', 'from'],
    sms: ['accountSid', 'authToken'],
    market: ['endpoint'],
  };
  return !!keys[name]?.every((key) => config[key]);
}
function availablePayments(shop, cfg, selected = currency(shop.currency), items = []) {
  const country = shop.country || 'BD';
  return paymentMethods.filter((method) => {
    if (method === 'cod')
      return (
        shop.codEnabled !== false &&
        selected === currency(shop.currency) &&
        items.every((item) => item.codEnabled !== false)
      );
    if (
      ['sslcommerz', 'aamarpay', 'shurjopay', 'bkash'].includes(method) &&
      (selected !== 'BDT' || country !== 'BD')
    )
      return false;
    if (method === 'paypal' && !paypalCurrencies.includes(selected)) return false;
    return providerReady(method, cfg[method]);
  });
}
function publicTracking(cfg) {
  return {
    metaPixelId:
      providerReady('meta', cfg.meta) && /^\d{5,30}$/.test(cfg.meta.pixelId) ? cfg.meta.pixelId : null,
  };
}
async function requestJson(url, options, label) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000), redirect: 'error' });
  } catch {
    throw new HttpError(502, `${label} could not be reached. Try again.`);
  }
  const data = await response.json().catch(() => ({}));
  assert(response.ok, 502, `${label} returned an error (${response.status})`);
  return data;
}
function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return (
      a > 0 &&
      a < 224 &&
      ![10, 127].includes(a) &&
      !(a === 169 && b === 254) &&
      !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) &&
      !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 198 && [18, 19].includes(b))
    );
  }
  return (
    isIP(address) === 6 &&
    /^[23][0-9a-f]{3}:/i.test(address) &&
    !/^2001:db8:/i.test(address) &&
    !/^2002:/i.test(address)
  );
}
async function externalUrl(value) {
  const url = new URL(webUrl(value));
  assert(
    url.protocol === 'https:' &&
      (!url.port || url.port === '443') &&
      !isIP(url.hostname.replace(/^\[|\]$/g, '')),
    400,
    'Enter a public HTTPS hostname',
  );
  let addresses;
  try {
    addresses = await lookup(url.hostname, { all: true });
  } catch {
    throw new HttpError(400, 'The hostname could not be resolved');
  }
  assert(
    addresses.length && addresses.every(({ address }) => isPublicAddress(address)),
    400,
    'The endpoint must use a public IP address',
  );
  return url;
}
async function publicRequest(url, options, label) {
  const target = await externalUrl(url.toString());
  const [chosen] = await lookup(target.hostname, { all: true });
  assert(chosen && isPublicAddress(chosen.address), 400, 'The endpoint must use a public IP address');
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      target,
      {
        ...options,
        agent: false,
        lookup(_host, opts, callback) {
          if (opts.all) callback(null, [chosen]);
          else callback(null, chosen.address, chosen.family);
        },
        signal: AbortSignal.timeout(12_000),
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 2_000_000) request.destroy(new HttpError(502, `${label} response was too large`));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300)
            return reject(new HttpError(502, `${label} returned an error (${response.statusCode})`));
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch {
            resolve({});
          }
        });
      },
    );
    request.on('error', (error) =>
      reject(error instanceof HttpError ? error : new HttpError(502, `${label} could not be reached`)),
    );
    request.end(options.body);
  });
}
function parseCustomer(input = {}) {
  const customer = {
    name: trim(input.name, 100),
    phone: trim(input.phone, 30),
    email: email(input.email),
    address: trim(input.address, 300),
    city: trim(input.city, 100),
    region: trim(input.region, 100),
    postcode: trim(input.postcode, 20),
    country: (trim(input.country, 2) || 'BD').toUpperCase(),
    pathaoCity: Number(input.pathaoCity) || undefined,
    pathaoZone: Number(input.pathaoZone) || undefined,
    pathaoArea: Number(input.pathaoArea) || undefined,
    notifySms: input.notifySms === true,
    notifyWhatsapp: input.notifyWhatsapp === true,
  };
  assert(
    customer.name.length >= 2 &&
      /^\+?[\d ()-]{8,24}$/.test(customer.phone) &&
      customer.address.length >= 5,
    400,
    'Enter a recipient name, phone and delivery address',
  );
  assert(!input.email || customer.email, 400, 'Enter a valid email address');
  assert(/^[A-Z]{2}$/.test(customer.country), 400, 'Enter a two-letter delivery country');
  return customer;
}
function chooseCurrency(shop, requested) {
  const base = currency(shop.currency);
  const selected = currency(requested, base);
  if (selected === base) return { base, selected, rate: 1 };
  const rate = Number(shop.rates?.[selected]);
  assert(Number.isFinite(rate) && rate > 0, 400, 'This shop does not offer that currency');
  return { base, selected, rate };
}
function checkoutItems(items) {
  assert(
    Array.isArray(items) && items.length > 0 && items.length <= 50,
    400,
    'Choose between one and 50 items',
  );
  const merged = new Map();
  for (const item of items) {
    const productId = recordId(item?.id || item?.productId);
    const variantId = trim(item.variantId, 60);
    const key = `${productId}:${variantId}`;
    const qty = number(item.qty, 'Quantity', 1, 100, true) + (merged.get(key)?.qty || 0);
    assert(qty <= 100, 400, 'The maximum quantity of one item is 100');
    merged.set(key, { productId, variantId, qty });
  }
  return [...merged.values()];
}
async function quoteOrder(database, shop, input, session) {
  const { selected, base, rate } = chooseCurrency(shop, input.currency);
  const customer = parseCustomer(input.customer);
  const requested = checkoutItems(input.items);
  const products = await database
    .collection('products')
    .find(
      {
        _id: { $in: requested.map((item) => item.productId) },
        shopSlug: shop.slug,
        active: { $ne: false },
        moderation: { $ne: 'hidden' },
      },
      { session },
    )
    .toArray();
  const lines = requested.map((item) => {
    const product = products.find((entry) => entry._id.equals(item.productId));
    assert(product, 409, 'A product in your cart is no longer available');
    const variant = product.variants?.find((entry) => entry.id === item.variantId);
    assert(
      (!item.variantId && !product.variants?.length) || variant,
      400,
      `Select an available variant of ${product.name}`,
    );
    assert(
      product.backorder || (variant?.stock ?? product.stock) >= item.qty,
      409,
      `Only ${Math.max(0, variant?.stock ?? product.stock)} available for ${product.name}`,
    );
    return {
      ...item,
      name: product.name,
      variantName: variant?.name || '',
      price: money(minor(variant?.price ?? product.price)),
      unitMinor: minor((variant?.price ?? product.price) * rate),
      baseMinor: minor(variant?.price ?? product.price),
      sku: variant?.sku || product.sku || '',
      weight: product.weight || 0,
      backorder: !!product.backorder,
      lowStock: product.lowStock ?? 5,
      codEnabled: product.codEnabled !== false,
    };
  });
  const subtotal = lines.reduce((sum, item) => sum + item.unitMinor * item.qty, 0);
  const subtotalBase = lines.reduce((sum, item) => sum + item.baseMinor * item.qty, 0);
  const weight = lines.reduce((sum, item) => sum + item.weight * item.qty, 0);
  const methods = (shop.shipping || []).filter(
    (item) =>
      (item.country === '*' || item.country === customer.country) &&
      (!item.postalPrefix ||
        customer.postcode.toUpperCase().startsWith(item.postalPrefix.toUpperCase())),
  );
  let shipping =
    methods.find((item) => item.id === input.shippingId) || (!input.shippingId ? methods[0] : null);
  assert(
    !input.shippingId || shipping || (input.shippingId === 'standard' && !methods.length),
    400,
    'Choose a valid delivery option',
  );
  if (!shipping) {
    assert(
      customer.country === (shop.country || 'BD') &&
        !(shop.shipping || []).some((item) => item.country === customer.country),
      400,
      'This shop has no delivery option for that destination',
    );
    shipping = { id: 'standard', label: 'Standard delivery', base: 0, perKg: 0 };
  }
  const shippingMinor = minor((shipping.base + shipping.perKg * weight) * rate);
  const now = today();
  const code = trim(input.discountCode, 32).toUpperCase();
  const filter = {
    shopSlug: shop.slug,
    active: true,
    startsAt: { $lte: now },
    $or: [{ endsAt: null }, { endsAt: { $gte: now } }],
  };
  const discounts = await database
    .collection('discounts')
    .find(
      { ...filter, ...(code ? { code } : { type: { $in: ['flash', 'bundle'] }, automatic: true }) },
      { session },
    )
    .limit(30)
    .toArray();
  let discount = null;
  let discountMinor = 0;
  for (const item of discounts) {
    if ((item.maxUses && item.uses >= item.maxUses) || subtotalBase < minor(item.minSubtotal || 0))
      continue;
    const selectedLines = item.productIds?.length
      ? lines.filter((line) => item.productIds.includes(String(line.productId)))
      : lines;
    if (
      !selectedLines.length ||
      (item.type === 'bundle' &&
        (selectedLines.reduce((sum, line) => sum + line.qty, 0) < item.minQuantity ||
          item.productIds.some((id) => !selectedLines.some((line) => String(line.productId) === id))))
    )
      continue;
    const eligible = selectedLines.reduce((sum, line) => sum + line.unitMinor * line.qty, 0);
    const saving = Math.min(
      eligible,
      item.type === 'fixed' ? minor(item.value * rate) : Math.round((eligible * item.value) / 100),
    );
    if (saving > discountMinor) {
      discount = item;
      discountMinor = saving;
    }
  }
  assert(
    !code || discount,
    400,
    'This discount code is expired, unavailable or does not apply to your cart',
  );
  const affiliateCode = lower(input.affiliateCode, 40);
  const affiliate = affiliateCode
    ? await database
        .collection('affiliates')
        .findOne({ shopSlug: shop.slug, code: affiliateCode, status: 'active' }, { session })
    : null;
  const amountMinor = subtotal + shippingMinor - discountMinor;
  return {
    customer,
    lines,
    base,
    selected,
    rate,
    subtotal,
    shipping,
    shippingMinor,
    discount,
    discountMinor,
    affiliate,
    amountMinor,
    methods,
  };
}
function quoteView(quote, shop, cfg) {
  const localWallets = ['sslcommerz', 'aamarpay', 'shurjopay', 'bkash'];
  return {
    currency: quote.selected,
    baseCurrency: quote.base,
    rate: quote.rate,
    subtotal: money(quote.subtotal),
    shipping: money(quote.shippingMinor),
    discount: money(quote.discountMinor),
    total: money(quote.amountMinor),
    discountCode: quote.discount?.code || null,
    shippingId: quote.shipping.id,
    shippingOptions: (quote.methods.length ? quote.methods : [quote.shipping]).map(
      ({ id, label, base, perKg }) => ({ id, label, base, perKg }),
    ),
    payments: availablePayments(shop, cfg, quote.selected, quote.lines).filter((method) =>
      method === 'cod'
        ? quote.customer.country === (shop.country || 'BD')
        : (!localWallets.includes(method) || quote.customer.country === 'BD') && quote.amountMinor > 0,
    ),
  };
}
app.post(
  '/shops/:slug/checkout/quote',
  route(async (req, res) => {
    const database = await db(),
      shop = await findShop(database, req.params.slug, true);
    const quote = await quoteOrder(database, shop, req.body);
    res.json(quoteView(quote, shop, await providerConfig(database, shop.slug)));
  }),
);
function orderAccessToken(order) {
  assert(env.SHOPOS_PROXY_SECRET, 503, 'Configure SHOPOS_PROXY_SECRET');
  return sign(`order:${order._id}:${order.shopSlug}:${order.checkoutKey || 'legacy'}`);
}
function orderView(order) {
  return {
    id: String(order._id),
    total: order.total,
    currency: currency(order.currency),
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    status: order.status,
    shopSlug: order.shopSlug,
    token: orderAccessToken(order),
    courier: order.courier
      ? {
          provider: order.courier.provider,
          trackingCode: order.courier.trackingCode,
          status: order.courier.status,
          trackingUrl: order.courier.trackingUrl,
        }
      : null,
  };
}
async function accessOrder(database, req, token = req.query.token) {
  const order = await database.collection('orders').findOne({
    _id: recordId(req.params.orderId),
    ...(req.params.slug ? { shopSlug: req.params.slug } : {}),
  });
  assert(order && safeEqual(token, orderAccessToken(order)), 404, 'Order not found');
  return order;
}
async function changeStock(database, order, direction, session) {
  for (const item of order.items) {
    const productId = typeof item.productId === 'string' ? toId(item.productId) : item.productId;
    const filter = { _id: productId, shopSlug: order.shopSlug };
    if (item.variantId)
      filter.variants = {
        $elemMatch: {
          id: item.variantId,
          ...(direction < 0 && !item.backorder ? { stock: { $gte: item.qty } } : {}),
        },
      };
    else if (direction < 0 && !item.backorder) filter.stock = { $gte: item.qty };
    const stockField = item.variantId ? 'variants.$.stock' : 'stock';
    const result = await database
      .collection('products')
      .findOneAndUpdate(
        filter,
        { $inc: { [stockField]: item.qty * direction }, $set: { updatedAt: today() } },
        { session, returnDocument: 'after' },
      );
    if (direction < 0) {
      assert(result, 409, `Stock changed for ${item.name}. Update your cart and try again.`);
      const stock = item.variantId
        ? result.variants.find((variant) => variant.id === item.variantId)?.stock
        : result.stock;
      if (stock <= item.lowStock)
        await notice(
          database,
          order.shopSlug,
          'inventory',
          `${item.name} is low in stock`,
          `${Math.max(0, stock)} remaining`,
          session,
        );
    }
  }
}
async function orderEvent(database, order, name, eventId, session) {
  if (!order.tracking?.consent) return;
  await recordEvent(
    database,
    order.shopSlug,
    {
      name,
      eventId,
      visitor: order.tracking.visitor,
      channel: order.tracking.channel,
      pageSlug: order.pageSlug,
      variant: order.pageVariant,
      url: order.tracking.url,
      value: order.total,
      currency: currency(order.currency),
      consent: true,
      customer: order.customer,
      fbp: order.tracking.fbp,
      fbc: order.tracking.fbc,
    },
    session,
  );
}
async function queueAutoCourier(database, shop, order, session) {
  const provider = shop?.autoCourier;
  if (
    !['steadfast', 'pathao'].includes(provider) ||
    order.customer.country !== 'BD' ||
    order.currency !== 'BDT'
  )
    return;
  if (provider === 'pathao' && (!order.customer.pathaoCity || !order.customer.pathaoZone)) return;
  await queue(
    database,
    shop.slug,
    'courier.create',
    { orderId: String(order._id), provider },
    today(),
    session,
  );
}
app.post(
  '/shops/:slug/orders',
  route(async (req, res) => {
    const database = await db(),
      shop = await findShop(database, req.params.slug, true);
    const method = req.body.paymentMethod || 'cod';
    assert(paymentMethods.includes(method), 400, 'Choose an available payment method');
    const checkoutKey = trim(req.body.checkoutKey, 80) || randomUUID();
    assert(/^[\w-]{12,80}$/.test(checkoutKey), 400, 'Invalid checkout reference');
    const user = actor(req);
    const cfg = await providerConfig(database, shop.slug);
    const fingerprint = hash(
      JSON.stringify([
        req.body.customer,
        req.body.items,
        req.body.currency,
        req.body.shippingId,
        req.body.discountCode,
        method,
      ]),
    );
    const prior = await database.collection('orders').findOne({ shopSlug: shop.slug, checkoutKey });
    if (prior) {
      assert(
        prior.checkoutFingerprint === fingerprint,
        409,
        'This checkout reference was already used for a different cart',
      );
      return headersNoStore(res).json(orderView(prior));
    }
    const attribution = await landingAttribution(
      database,
      shop.slug,
      req.body.pageSlug,
      req.body.pageVariant,
      req.body.tracking?.visitor,
    );
    let order;
    try {
      order = await transaction(async (database, session) => {
        const quote = await quoteOrder(database, shop, req.body, session);
        const view = quoteView(quote, shop, cfg);
        assert(
          view.payments.includes(method),
          400,
          'The selected payment method is unavailable for this order',
        );
        if (['sslcommerz', 'aamarpay', 'shurjopay'].includes(method))
          assert(quote.customer.email, 400, 'An email address is required for this payment gateway');
        assert(method === 'cod' || quote.amountMinor > 0, 400, 'Use cash on delivery for a zero total');
        const commission = Number(
          shop.commissionPercent ??
            (await database.collection('platform').findOne({ _id: 'plans' }, { session }))?.values?.[
              effectivePlan(shop)
            ]?.commissionPercent ??
            env.PLATFORM_COMMISSION_PERCENT ??
            0,
        );
        const order = {
          _id: new ObjectId(),
          shopSlug: shop.slug,
          ownerId: shop.ownerId,
          customerId: user?.id || null,
          customer: quote.customer,
          items: quote.lines,
          total: view.total,
          amountMinor: quote.amountMinor,
          subtotal: view.subtotal,
          shippingTotal: view.shipping,
          shippingLabel: quote.shipping.label,
          baseCurrency: quote.base,
          currency: quote.selected,
          rate: quote.rate,
          totalBase: money(Math.round(quote.amountMinor / quote.rate)),
          discountCode: view.discountCode,
          discountId: quote.discount?._id,
          discount: view.discount,
          paymentMethod: method,
          paymentStatus: method === 'cod' ? 'cod_pending' : 'pending',
          status: 'pending',
          stockReserved: true,
          checkoutKey,
          checkoutFingerprint: fingerprint,
          platformFeeMinor: Math.max(
            0,
            Math.round((quote.amountMinor * Math.min(100, commission)) / 100),
          ),
          affiliateId: quote.affiliate?._id,
          affiliateCode: quote.affiliate?.code,
          affiliateCommission: quote.affiliate
            ? money(Math.round(((quote.subtotal - quote.discountMinor) * quote.affiliate.percent) / 100))
            : 0,
          pageSlug: attribution?.slug,
          pageVariant: attribution?.variant,
          tracking: {
            consent: req.body.tracking?.consent === true,
            visitor: trim(req.body.tracking?.visitor, 100),
            channel: trim(req.body.tracking?.channel, 40),
            url: trim(req.body.tracking?.url, 1500),
            fbp: trim(req.body.tracking?.fbp, 120),
            fbc: trim(req.body.tracking?.fbc, 150),
          },
          createdAt: today(),
          updatedAt: today(),
        };
        await changeStock(database, order, -1, session);
        if (quote.discount)
          await database
            .collection('discounts')
            .updateOne({ _id: quote.discount._id }, { $inc: { uses: 1 } }, { session });
        await database.collection('orders').insertOne(order, { session });
        await database
          .collection('abandoned')
          .deleteOne({ shopSlug: shop.slug, visitor: order.tracking.visitor }, { session });
        await notice(
          database,
          shop.slug,
          'order',
          'New order',
          `${quote.customer.name} · ${quote.selected} ${view.total.toFixed(2)}`,
          session,
        );
        await enqueueWebhooks(
          database,
          shop.slug,
          'order.created',
          { id: String(order._id), total: order.total, currency: order.currency, paymentMethod: method },
          session,
        );
        if (method === 'cod') {
          await orderEvent(database, order, 'Purchase', `order-${order._id}`, session);
          await queue(
            database,
            shop.slug,
            'order.message',
            { orderId: String(order._id), status: 'received' },
            today(),
            session,
          );
          await queueAutoCourier(database, shop, order, session);
        }
        return order;
      });
    } catch (error) {
      if (error.code !== 11000) throw error;
      order = await database.collection('orders').findOne({ shopSlug: shop.slug, checkoutKey });
      assert(
        order && order.checkoutFingerprint === fingerprint,
        409,
        'A different order already uses this checkout reference',
      );
    }
    headersNoStore(res).status(201).json(orderView(order));
  }),
);
app.get(
  ['/shops/:slug/orders/:orderId/status', '/payments/order/:orderId/status'],
  route(async (req, res) => {
    const database = await db();
    const order = await accessOrder(database, req);
    headersNoStore(res).json(orderView(order));
  }),
);
app.get(
  '/shops/:slug/my-orders',
  route(async (req, res) => {
    const user = requireActor(req),
      database = await db();
    const orders = await database
      .collection('orders')
      .find({ shopSlug: req.params.slug, customerId: user.id })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    headersNoStore(res).json(
      orders.map((order) => ({ ...orderView(order), items: order.items, createdAt: order.createdAt })),
    );
  }),
);
app.get(
  '/shops/:slug/orders',
  route(async (req, res) => {
    const { database, shop } = await workspace(req);
    const { limit, skip } = pageLimit(req, 60);
    const filter = { shopSlug: shop.slug };
    if (req.query.status) filter.status = trim(req.query.status, 30);
    headersNoStore(res).json(
      (
        await database
          .collection('orders')
          .find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray()
      ).map((order) => {
        const output = serialize(order);
        for (const key of ['checkoutKey', 'checkoutFingerprint', 'tracking', 'checkoutUrl'])
          delete output[key];
        return output;
      }),
    );
  }),
);
app.get(
  '/shops/:slug/orders/:orderId/tracking-link',
  route(async (req, res) => {
    const { database, shop } = await workspace(req, 'orders');
    const order = await database
      .collection('orders')
      .findOne({ _id: recordId(req.params.orderId), shopSlug: shop.slug });
    assert(order, 404, 'Order not found');
    const query = new URLSearchParams({ order: String(order._id), token: orderAccessToken(order) });
    headersNoStore(res).json({
      url: `${clientUrl}/shops/${encodeURIComponent(shop.slug)}/order-success?${query}`,
    });
  }),
);
const transitions = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['shipped', 'cancelled'],
  shipped: ['delivered', 'returned'],
  delivered: ['returned'],
};
async function setOrderStatus(shop, orderId, status, userId) {
  return transaction(async (database, session) => {
    const filter = { _id: orderId, shopSlug: shop.slug };
    const order = await database.collection('orders').findOne(filter, { session });
    assert(order, 404, 'Order not found');
    if (order.status === status) return order;
    assert(
      !order.courierLock,
      409,
      'Reconcile the in-progress courier request before changing this order',
    );
    assert(transitions[order.status]?.includes(status), 409, `Cannot move ${order.status} to ${status}`);
    if (['confirmed', 'shipped', 'delivered'].includes(status))
      assert(
        order.paymentMethod === 'cod' || order.paymentStatus === 'paid',
        409,
        'Wait for verified payment before fulfilling this order',
      );
    const restock = ['cancelled', 'returned'].includes(status) && order.stockReserved !== false;
    if (restock) await changeStock(database, order, 1, session);
    if (restock && order.discountId)
      await database
        .collection('discounts')
        .updateOne({ _id: order.discountId, uses: { $gt: 0 } }, { $inc: { uses: -1 } }, { session });
    const set = { status, updatedAt: today(), ...(restock ? { stockReserved: false } : {}) };
    if (status === 'delivered') set.deliveredAt = today();
    if (status === 'delivered' && order.paymentMethod === 'cod') set.paymentStatus = 'paid';
    if (
      ['returned', 'cancelled'].includes(status) &&
      order.paymentStatus === 'paid' &&
      order.paymentMethod !== 'cod'
    )
      set.paymentStatus = 'refund_due';
    await database.collection('orders').updateOne(filter, { $set: set }, { session });
    await audit(database, shop.slug, userId, `order.${status}`, String(orderId), session);
    await queue(
      database,
      shop.slug,
      'order.message',
      { orderId: String(orderId), status },
      today(),
      session,
    );
    await enqueueWebhooks(
      database,
      shop.slug,
      'order.updated',
      { id: String(orderId), status },
      session,
    );
    return { ...order, ...set };
  });
}
app.patch(
  '/shops/:slug/orders/:orderId',
  route(async (req, res) => {
    const { shop, user } = await workspace(req, 'orders');
    const order = await setOrderStatus(
      shop,
      recordId(req.params.orderId),
      trim(req.body.status, 30),
      user.id,
    );
    res.json({ id: String(order._id), status: order.status, paymentStatus: order.paymentStatus });
  }),
);

function checkoutReturn(order, kind) {
  return `${clientUrl}/payment-success?${new URLSearchParams({ gateway: kind, order: String(order._id), shop: order.shopSlug, token: orderAccessToken(order) })}`;
}
function stripeClient(config) {
  return new Stripe(config.secretKey, { timeout: 15_000, maxNetworkRetries: 1 });
}
function stripeOptions(cfg, extra = {}) {
  return { ...(cfg.accountId ? { stripeAccount: cfg.accountId } : {}), ...extra };
}
function sslBase(cfg) {
  return cfg.sandbox === false ? 'https://securepay.sslcommerz.com' : 'https://sandbox.sslcommerz.com';
}
function paypalBase(cfg) {
  return cfg.sandbox === false ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}
function aamarBase(cfg) {
  return cfg.sandbox === false ? 'https://secure.aamarpay.com' : 'https://sandbox.aamarpay.com';
}
async function paypalRequest(cfg, path, init = {}) {
  const token = await requestJson(
    `${paypalBase(cfg)}/v1/oauth2/token`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    },
    'PayPal authentication',
  );
  assert(token.access_token, 502, 'PayPal authentication failed');
  return requestJson(
    `${paypalBase(cfg)}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    },
    'PayPal',
  );
}
function shurjoBase(cfg) {
  return cfg.sandbox === false
    ? 'https://engine.shurjopayment.com/api'
    : 'https://sandbox.shurjopayment.com/api';
}
function bkashBase(cfg) {
  return `https://${cfg.sandbox === false ? 'tokenized' : 'tokenized.sandbox'}.pay.bka.sh/v1.2.0-beta/tokenized/checkout`;
}
async function localWalletRequest(provider, cfg, path, payload) {
  const shurjo = provider === 'shurjopay';
  const base = shurjo ? shurjoBase(cfg) : bkashBase(cfg);
  const jsonHeaders = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const auth = await requestJson(
    `${base}${shurjo ? '/get_token' : '/token/grant'}`,
    {
      method: 'POST',
      headers: shurjo ? jsonHeaders : { ...jsonHeaders, username: cfg.username, password: cfg.password },
      body: JSON.stringify(
        shurjo
          ? { username: cfg.username, password: cfg.password }
          : { app_key: cfg.appKey, app_secret: cfg.appSecret },
      ),
    },
    `${provider} authentication`,
  );
  const token = shurjo ? auth.token : auth.id_token;
  assert(token, 502, `${provider} authentication failed`);
  return requestJson(
    `${base}${path}`,
    {
      method: 'POST',
      headers: {
        ...jsonHeaders,
        Authorization: shurjo ? `Bearer ${token}` : token,
        ...(shurjo ? {} : { 'X-App-Key': cfg.appKey }),
      },
      body: JSON.stringify(
        shurjo && path === '/secret-pay' ? { ...payload, token, store_id: auth.store_id } : payload,
      ),
    },
    provider,
  );
}
async function startPayment(order, cfg) {
  const total = Number(order.total).toFixed(2);
  const orderId = String(order._id),
    cur = currency(order.currency),
    buyer = order.customer;
  switch (order.paymentMethod) {
    case 'stripe': {
      const data = await stripeClient(cfg).checkout.sessions.create(
        {
          mode: 'payment',
          payment_method_types: ['card'],
          client_reference_id: orderId,
          customer_email: buyer.email || undefined,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: cur.toLowerCase(),
                product_data: { name: `Shop order ${orderId.slice(-7)}` },
                unit_amount: order.amountMinor ?? minor(order.total),
              },
            },
          ],
          metadata: { orderId, shopSlug: order.shopSlug, purpose: 'storefront' },
          payment_intent_data:
            cfg.accountId && order.platformFeeMinor
              ? { application_fee_amount: order.platformFeeMinor }
              : undefined,
          success_url: `${checkoutReturn(order, 'stripe')}&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${checkoutReturn(order, 'stripe')}&cancelled=1`,
        },
        stripeOptions(cfg, { idempotencyKey: `order-${orderId}` }),
      );
      return { url: data.url, providerId: data.id, expiresAt: new Date(data.expires_at * 1000) };
    }
    case 'sslcommerz': {
      const callback = `${serverUrl}/payments/sslcommerz/callback?proof=${orderAccessToken(order)}`;
      const form = new URLSearchParams({
        store_id: cfg.storeId,
        store_passwd: cfg.storePassword,
        total_amount: total,
        currency: cur,
        tran_id: orderId,
        success_url: callback,
        fail_url: `${callback}&result=failed`,
        cancel_url: `${callback}&result=cancelled`,
        ipn_url: `${serverUrl}/payments/sslcommerz/ipn`,
        product_name: 'ShopOS order',
        product_category: 'Retail',
        product_profile: 'general',
        num_of_item: String(order.items.reduce((sum, item) => sum + item.qty, 0)),
        shipping_method: 'Courier',
        cus_name: buyer.name,
        cus_email: buyer.email,
        cus_phone: buyer.phone,
        cus_add1: buyer.address,
        cus_city: buyer.city || 'Dhaka',
        cus_state: buyer.region || buyer.city || 'Dhaka',
        cus_postcode: buyer.postcode || '1000',
        cus_country: 'Bangladesh',
        ship_name: buyer.name,
        ship_add1: buyer.address,
        ship_city: buyer.city || 'Dhaka',
        ship_state: buyer.region || buyer.city || 'Dhaka',
        ship_postcode: buyer.postcode || '1000',
        ship_country: 'Bangladesh',
      });
      const data = await requestJson(
        `${sslBase(cfg)}/gwprocess/v4/api.php`,
        { method: 'POST', body: form },
        'SSLCommerz',
      );
      assert(
        data.status === 'SUCCESS' && data.GatewayPageURL,
        502,
        'SSLCommerz could not start checkout. Check the merchant settings.',
      );
      return {
        url: data.GatewayPageURL,
        providerId: data.sessionkey || orderId,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      };
    }
    case 'paypal': {
      const data = await paypalRequest(cfg, '/v2/checkout/orders', {
        method: 'POST',
        headers: { 'PayPal-Request-Id': orderId },
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [
            { reference_id: orderId, custom_id: orderId, amount: { currency_code: cur, value: total } },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                shipping_preference: 'NO_SHIPPING',
                user_action: 'PAY_NOW',
                return_url: `${serverUrl}/payments/paypal/callback?order=${orderId}`,
                cancel_url: `${checkoutReturn(order, 'paypal')}&cancelled=1`,
              },
            },
          },
        }),
      });
      return {
        url: data.links?.find((link) => ['payer-action', 'approve'].includes(link.rel))?.href,
        providerId: data.id,
        expiresAt: new Date(Date.now() + 3 * 60 * 60_000),
      };
    }
    case 'aamarpay': {
      const callback = `${serverUrl}/payments/aamarpay/callback?order=${orderId}&proof=${orderAccessToken(order)}`;
      const data = await requestJson(
        `${aamarBase(cfg)}/jsonpost.php`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            store_id: cfg.storeId,
            signature_key: cfg.signature,
            tran_id: orderId,
            success_url: callback,
            fail_url: `${callback}&result=failed`,
            cancel_url: `${callback}&result=cancelled`,
            amount: total,
            currency: cur,
            desc: 'ShopOS order',
            cus_name: buyer.name,
            cus_email: buyer.email,
            cus_phone: buyer.phone,
            type: 'json',
          }),
        },
        'aamarPay',
      );
      return {
        url: data.payment_url,
        providerId: orderId,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      };
    }
    case 'bkash': {
      const data = await localWalletRequest('bkash', cfg, '/create', {
        mode: '0011',
        payerReference: buyer.phone,
        callbackURL: `${serverUrl}/payments/bkash/callback?order=${orderId}&proof=${orderAccessToken(order)}`,
        amount: total,
        currency: cur,
        intent: 'sale',
        merchantInvoiceNumber: orderId,
      });
      assert(data.statusCode === '0000', 502, 'bKash could not start checkout');
      return {
        url: data.bkashURL,
        providerId: data.paymentID,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      };
    }
    case 'shurjopay': {
      const callback = `${serverUrl}/payments/shurjopay/callback?order=${orderId}&proof=${orderAccessToken(order)}`;
      const data = await localWalletRequest('shurjopay', cfg, '/secret-pay', {
        prefix: cfg.prefix,
        return_url: callback,
        cancel_url: `${callback}&result=cancelled`,
        amount: Number(total),
        order_id: orderId,
        currency: cur,
        customer_name: buyer.name,
        customer_address: buyer.address,
        customer_email: buyer.email,
        customer_phone: buyer.phone,
        customer_city: buyer.city || 'Dhaka',
        customer_post_code: buyer.postcode || '1000',
        customer_country: 'BD',
      });
      return {
        url: data.checkout_url,
        providerId: data.sp_order_id,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      };
    }
    default:
      throw new HttpError(400, 'This order does not use an online payment method');
  }
}
app.post(
  '/shops/:slug/orders/:orderId/pay',
  route(async (req, res) => {
    const database = await db();
    const order = await accessOrder(database, req, req.body?.token || req.query.token);
    assert(
      order.paymentStatus === 'pending' && order.status !== 'cancelled' && order.paymentMethod !== 'cod',
      409,
      'This order is no longer awaiting payment',
    );
    if (order.checkoutUrl && order.checkoutExpiresAt > today())
      return headersNoStore(res).json({ url: order.checkoutUrl });
    assert(
      !order.checkoutUrl,
      409,
      'This checkout expired. Ask the seller to cancel the unpaid order, then start a new checkout.',
    );
    const cfg = (await providerConfig(database, order.shopSlug))[order.paymentMethod];
    assert(providerReady(order.paymentMethod, cfg), 503, 'The selected gateway is unavailable');
    if (['sslcommerz', 'aamarpay', 'shurjopay'].includes(order.paymentMethod))
      assert(order.customer.email, 400, 'An email address is required for this payment gateway');
    const lock = randomUUID();
    const result = await database.collection('orders').updateOne(
      {
        _id: order._id,
        paymentStatus: 'pending',
        checkoutUrl: { $exists: false },
        $or: [{ paymentLockUntil: { $exists: false } }, { paymentLockUntil: { $lt: today() } }],
      },
      { $set: { paymentLock: lock, paymentLockUntil: new Date(Date.now() + 40_000) } },
    );
    assert(result.modifiedCount, 409, 'Checkout is being prepared. Try again in a moment.');
    try {
      const payment = await startPayment(order, cfg);
      assert(payment.url && payment.providerId, 502, 'The gateway did not return a checkout link');
      const url = webUrl(payment.url);
      assert(url.startsWith('https://'), 502, 'The gateway did not return a secure checkout link');
      await database.collection('orders').updateOne(
        { _id: order._id, paymentLock: lock },
        {
          $set: {
            checkoutUrl: url,
            checkoutSessionId: payment.providerId,
            checkoutExpiresAt: payment.expiresAt,
          },
          $unset: { paymentLock: '', paymentLockUntil: '' },
        },
      );
      headersNoStore(res).json({ url });
    } catch (error) {
      await database
        .collection('orders')
        .updateOne(
          { _id: order._id, paymentLock: lock },
          { $unset: { paymentLock: '', paymentLockUntil: '' } },
        );
      if (error.type?.startsWith('Stripe'))
        throw new HttpError(
          502,
          'Stripe could not start checkout. Check merchant configuration and the charge amount.',
        );
      throw error;
    }
  }),
);
async function markPaid(order, method, reference, risky = false) {
  assert(order.paymentMethod === method, 400, 'Payment method does not match this order');
  return transaction(async (database, session) => {
    const next = risky
      ? 'review'
      : order.status === 'cancelled' || order.status === 'returned'
        ? 'refund_due'
        : 'paid';
    const updated = await database.collection('orders').findOneAndUpdate(
      { _id: order._id, paymentMethod: method, paymentStatus: 'pending', status: order.status },
      {
        $set: {
          paymentStatus: next,
          paymentReference: reference,
          paidAt: today(),
          updatedAt: today(),
        },
      },
      { session, returnDocument: 'after' },
    );
    if (!updated) {
      const current = await database.collection('orders').findOne({ _id: order._id }, { session });
      if (current?.paymentStatus === 'pending' && ['cancelled', 'returned'].includes(current.status))
        await database
          .collection('orders')
          .updateOne(
            { _id: current._id, paymentStatus: 'pending' },
            { $set: { paymentStatus: 'refund_due', paymentReference: reference, paidAt: today() } },
            { session },
          );
      return;
    }
    await notice(
      database,
      order.shopSlug,
      'payment',
      next === 'paid' ? 'Payment received' : 'Review a payment',
      `Order ${String(order._id).slice(-7)} · ${order.currency || 'BDT'} ${order.total}`,
      session,
    );
    if (next === 'paid') {
      await orderEvent(database, updated, 'Purchase', `order-${order._id}`, session);
      await queue(
        database,
        order.shopSlug,
        'order.message',
        { orderId: String(order._id), status: 'paid' },
        today(),
        session,
      );
      const shop = await database.collection('shops').findOne({ slug: order.shopSlug }, { session });
      await queueAutoCourier(database, shop, updated, session);
    }
  });
}
async function verifyStripeSession(database, session, accountId) {
  const orderId = toId(session.metadata?.orderId);
  if (!orderId || session.payment_status !== 'paid' || session.metadata?.purpose !== 'storefront')
    return;
  const order = await database.collection('orders').findOne({
    _id: orderId,
    shopSlug: session.metadata.shopSlug,
    paymentMethod: 'stripe',
    checkoutSessionId: session.id,
  });
  if (!order) return;
  const cfg = (await providerConfig(database, order.shopSlug)).stripe;
  if (
    (cfg?.accountId || null) !== (accountId || null) ||
    session.amount_total !== (order.amountMinor ?? minor(order.total)) ||
    session.currency !== currency(order.currency).toLowerCase()
  )
    return;
  await markPaid(order, 'stripe', String(session.payment_intent || session.id));
}
async function stripeWebhook(req, res) {
  const database = await db();
  const cfg = req.params.slug ? (await providerConfig(database, req.params.slug)).stripe : null;
  const signature = req.get('stripe-signature');
  const candidates = cfg
    ? [[cfg.secretKey, cfg.webhookSecret]]
    : [
        [env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET],
        [env.STRIPE_SECRET_KEY, env.STRIPE_CONNECT_WEBHOOK_SECRET],
      ];
  let event;
  for (const [secretKey, webhookSecret] of candidates) {
    if (!secretKey || !webhookSecret) continue;
    try {
      event = stripeClient({ secretKey }).webhooks.constructEvent(req.body, signature, webhookSecret);
      break;
    } catch {
      /* Try the configured Connect endpoint key. */
    }
  }
  assert(event, 400, 'Invalid Stripe webhook signature');
  const object = event.data.object;
  if (req.params.slug && object.metadata?.shopSlug !== req.params.slug)
    return res.json({ received: true });
  if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    if (object.metadata?.purpose === 'billing' && !req.params.slug && !event.account)
      await applyBillingCheckout(database, object);
    else await verifyStripeSession(database, object, event.account);
  }
  if (
    !req.params.slug &&
    !event.account &&
    [
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'invoice.payment_failed',
      'invoice.paid',
    ].includes(event.type)
  )
    await updateBillingEvent(database, event);
  res.json({ received: true });
}
app.get(
  '/payments/stripe/session/:sessionId',
  route(async (req, res) => {
    const database = await db();
    const order = await database
      .collection('orders')
      .findOne({ checkoutSessionId: req.params.sessionId, paymentMethod: 'stripe' });
    assert(order && safeEqual(req.query.token, orderAccessToken(order)), 404, 'Order not found');
    const cfg = (await providerConfig(database, order.shopSlug)).stripe;
    const session = await stripeClient(cfg).checkout.sessions.retrieve(
      req.params.sessionId,
      {},
      stripeOptions(cfg),
    );
    await verifyStripeSession(database, session, cfg.accountId);
    headersNoStore(res).json(orderView(await database.collection('orders').findOne({ _id: order._id })));
  }),
);
async function sslNotification(req, res, ipn = false) {
  const fields = { ...req.query, ...req.body };
  const database = await db();
  const order = await database
    .collection('orders')
    .findOne({ _id: toId(fields.tran_id), paymentMethod: 'sslcommerz' });
  assert(order && (ipn || safeEqual(req.query.proof, orderAccessToken(order))), 404, 'Order not found');
  if (fields.val_id) {
    const cfg = (await providerConfig(database, order.shopSlug)).sslcommerz;
    assert(providerReady('sslcommerz', cfg), 503, 'SSLCommerz is unavailable');
    const search = new URLSearchParams({
      val_id: trim(fields.val_id, 90),
      store_id: cfg.storeId,
      store_passwd: cfg.storePassword,
      format: 'json',
    });
    const data = await requestJson(
      `${sslBase(cfg)}/validator/api/validationserverAPI.php?${search}`,
      {},
      'SSLCommerz validation',
    );
    assert(
      ['VALID', 'VALIDATED'].includes(data.status) &&
        data.tran_id === String(order._id) &&
        minor(data.amount) === (order.amountMinor ?? minor(order.total)) &&
        data.currency === 'BDT',
      400,
      'SSLCommerz validation failed',
    );
    await markPaid(order, 'sslcommerz', trim(data.bank_tran_id, 120), Number(data.risk_level) === 1);
  } else if (ipn) return res.json({ received: true });
  if (ipn) return res.json({ received: true });
  res.redirect(303, `${checkoutReturn(order, 'sslcommerz')}${fields.result ? '&cancelled=1' : ''}`);
}
app.all(
  '/payments/sslcommerz/callback',
  route((req, res) => sslNotification(req, res)),
);
app.post(
  '/payments/sslcommerz/ipn',
  route((req, res) => sslNotification(req, res, true)),
);
app.get(
  '/payments/paypal/callback',
  route(async (req, res) => {
    const database = await db();
    const order = await database.collection('orders').findOne({
      _id: toId(req.query.order),
      checkoutSessionId: trim(req.query.token, 100),
      paymentMethod: 'paypal',
    });
    assert(order, 404, 'PayPal order not found');
    if (order.paymentStatus === 'pending') {
      const cfg = (await providerConfig(database, order.shopSlug)).paypal;
      const path = `/v2/checkout/orders/${encodeURIComponent(order.checkoutSessionId)}`;
      let data = await paypalRequest(cfg, path);
      if (data.status === 'APPROVED')
        data = await paypalRequest(cfg, `${path}/capture`, {
          method: 'POST',
          headers: { 'PayPal-Request-Id': `${order._id}-capture` },
          body: '{}',
        });
      const unit = data.purchase_units?.find((entry) => entry.reference_id === String(order._id));
      const capture = unit?.payments?.captures?.find((entry) => entry.status === 'COMPLETED');
      if (
        capture &&
        data.status === 'COMPLETED' &&
        capture.amount.currency_code === order.currency &&
        minor(capture.amount.value) === order.amountMinor
      )
        await markPaid(order, 'paypal', capture.id);
    }
    res.redirect(303, checkoutReturn(order, 'paypal'));
  }),
);
app.all(
  '/payments/aamarpay/callback',
  route(async (req, res) => {
    const database = await db();
    const order = await database
      .collection('orders')
      .findOne({ _id: toId(req.query.order), paymentMethod: 'aamarpay' });
    assert(order && safeEqual(req.query.proof, orderAccessToken(order)), 404, 'Order not found');
    if (!req.query.result && order.paymentStatus === 'pending') {
      const cfg = (await providerConfig(database, order.shopSlug)).aamarpay;
      const search = new URLSearchParams({
        request_id: String(order._id),
        store_id: cfg.storeId,
        signature_key: cfg.signature,
        type: 'json',
      });
      const data = await requestJson(
        `${aamarBase(cfg)}/api/v1/trxcheck/request.php?${search}`,
        {},
        'aamarPay validation',
      );
      if (
        ['Successful', 'Success'].includes(data.pay_status) &&
        data.mer_txnid === String(order._id) &&
        minor(data.amount) === order.amountMinor &&
        (!data.currency || data.currency === order.currency)
      )
        await markPaid(order, 'aamarpay', trim(data.pg_txnid, 120));
    }
    res.redirect(303, checkoutReturn(order, 'aamarpay'));
  }),
);

app.all(
  '/payments/:wallet/callback',
  route(async (req, res) => {
    const method = req.params.wallet;
    assert(['bkash', 'shurjopay'].includes(method), 404, 'Payment route not found');
    const database = await db();
    const order = await database
      .collection('orders')
      .findOne({ _id: toId(req.query.order), paymentMethod: method });
    assert(order && safeEqual(req.query.proof, orderAccessToken(order)), 404, 'Order not found');
    if (order.paymentStatus === 'pending' && order.checkoutSessionId && !req.query.result) {
      const cfg = (await providerConfig(database, order.shopSlug))[method];
      if (
        method === 'bkash' &&
        req.query.status === 'success' &&
        req.query.paymentID === order.checkoutSessionId
      ) {
        const data = await localWalletRequest(method, cfg, '/execute', {
          paymentID: order.checkoutSessionId,
        }).catch(() => ({}));
        const settled =
          data.transactionStatus === 'Completed'
            ? data
            : await localWalletRequest(method, cfg, '/payment/status', {
                paymentID: order.checkoutSessionId,
              });
        if (
          settled.transactionStatus === 'Completed' &&
          settled.paymentID === order.checkoutSessionId &&
          settled.merchantInvoiceNumber === String(order._id) &&
          settled.currency === 'BDT' &&
          minor(settled.amount) === order.amountMinor
        )
          await markPaid(order, method, settled.trxID);
      }
      if (
        method === 'shurjopay' &&
        (req.query.order_id || req.body?.order_id) === order.checkoutSessionId
      ) {
        const values = await localWalletRequest(method, cfg, '/verification', {
          order_id: order.checkoutSessionId,
        });
        const data = Array.isArray(values) ? values[0] : values;
        if (
          String(data?.sp_code) === '1000' &&
          data.order_id === order.checkoutSessionId &&
          data.customer_order_id === String(order._id) &&
          data.currency === 'BDT' &&
          minor(data.amount) === order.amountMinor
        )
          await markPaid(order, method, String(data.bank_trx_id || data.order_id));
      }
    }
    res.redirect(303, checkoutReturn(order, method));
  }),
);

// Courier dispatch and tracking
function pathaoBase(config) {
  return config.sandbox === false
    ? 'https://api-hermes.pathao.com'
    : 'https://courier-api-sandbox.pathao.com';
}
async function pathaoRequest(config, path, init = {}) {
  const token = await requestJson(
    `${pathaoBase(config)}/aladdin/api/v1/issue-token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        username: config.username,
        password: config.password,
        grant_type: 'password',
      }),
    },
    'Pathao authentication',
  );
  assert(token.access_token, 502, 'Pathao authentication failed');
  return requestJson(
    `${pathaoBase(config)}/aladdin/api/v1${path}`,
    {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token.access_token}`,
      },
    },
    'Pathao',
  );
}
function steadfastRequest(config, path, init = {}) {
  return requestJson(
    `https://portal.packzy.com/api/v1${path}`,
    {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': config.apiKey,
        'Secret-Key': config.secretKey,
      },
    },
    'Steadfast',
  );
}
function redxRequest(config, path, init = {}) {
  const base = config.sandbox === false ? 'https://openapi.redx.com.bd' : 'https://sandbox.redx.com.bd';
  return requestJson(
    `${base}/v1.0.0-beta${path}`,
    {
      ...init,
      headers: { 'Content-Type': 'application/json', 'API-ACCESS-TOKEN': `Bearer ${config.token}` },
    },
    'RedX',
  );
}
function shippoRequest(config, path, init = {}) {
  return requestJson(
    `https://api.goshippo.com${path}`,
    {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `ShippoToken ${config.token}` },
    },
    'Shippo',
  );
}
function shippoAddress(address) {
  return {
    name: address.name,
    street1: address.address,
    city: address.city,
    state: address.region,
    zip: address.postcode,
    country: address.country,
    phone: address.phone,
    email: address.email,
  };
}
async function shippoRates(shop, order, cfg) {
  assert(
    shop.shipFrom?.address && shop.shipFrom?.city && shop.shipFrom?.postcode,
    400,
    'Set the ship-from address in Store settings',
  );
  assert(
    order.customer.city && order.customer.postcode,
    400,
    'The order needs a destination city and postal code',
  );
  const weight = Math.max(
    0.1,
    order.items.reduce((sum, item) => sum + (item.weight || 0) * item.qty, 0),
  );
  const parcel = shop.parcel || { length: 25, width: 20, height: 10 };
  const data = await shippoRequest(cfg, '/shipments/', {
    method: 'POST',
    body: JSON.stringify({
      address_from: shippoAddress(shop.shipFrom),
      address_to: shippoAddress(order.customer),
      parcels: [{ ...parcel, weight: weight.toFixed(3), distance_unit: 'cm', mass_unit: 'kg' }],
      async: false,
    }),
  });
  return (data.rates || []).map((rate) => ({
    id: rate.object_id,
    provider: rate.provider,
    service: rate.servicelevel?.name,
    amount: rate.amount,
    currency: rate.currency,
    days: rate.estimated_days,
  }));
}
app.get(
  '/shops/:slug/couriers/pathao/areas',
  route(async (req, res) => {
    const database = await db(),
      shop = await findShop(database, req.params.slug, true);
    const cfg = (await providerConfig(database, shop.slug)).pathao;
    assert(providerReady('pathao', cfg), 503, 'Pathao is not connected');
    const city = Number(req.query.city),
      zone = Number(req.query.zone);
    const path =
      zone > 0
        ? `/zones/${Math.trunc(zone)}/area-list`
        : city > 0
          ? `/cities/${Math.trunc(city)}/zone-list`
          : '/countries/1/city-list';
    const data = await pathaoRequest(cfg, path);
    res.json(
      (data.data?.data || []).map((item) => ({
        id: item.area_id || item.zone_id || item.city_id,
        name: item.area_name || item.zone_name || item.city_name,
      })),
    );
  }),
);
app.get(
  '/shops/:slug/couriers/redx/areas',
  route(async (req, res) => {
    const { database, shop } = await workspace(req, 'orders');
    const cfg = (await providerConfig(database, shop.slug)).redx;
    assert(providerReady('redx', cfg), 503, 'RedX is not connected');
    const data = await redxRequest(cfg, '/areas');
    res.json(
      (Array.isArray(data.areas) ? data.areas : []).map((item) => ({ id: item.id, name: item.name })),
    );
  }),
);
app.post(
  '/shops/:slug/orders/:orderId/rates',
  route(async (req, res) => {
    const { database, shop } = await workspace(req, 'orders');
    const order = await database
      .collection('orders')
      .findOne({ _id: recordId(req.params.orderId), shopSlug: shop.slug });
    const cfg = (await providerConfig(database, shop.slug)).shippo;
    assert(order, 404, 'Order not found');
    assert(providerReady('shippo', cfg), 503, 'Connect Shippo to request rates');
    const rates = await shippoRates(shop, order, cfg);
    await database
      .collection('orders')
      .updateOne({ _id: order._id }, { $set: { quotedRates: rates, ratesAt: today() } });
    res.json(rates);
  }),
);
async function dispatchCourier(shop, orderId, provider, options = {}) {
  const database = await db();
  const cfg = (await providerConfig(database, shop.slug))[provider];
  assert(
    courierMethods.includes(provider) && providerReady(provider, cfg),
    503,
    'Connect the selected courier first',
  );
  const order = await database.collection('orders').findOne({ _id: orderId, shopSlug: shop.slug });
  assert(order, 404, 'Order not found');
  if (order.courier?.consignmentId) return order.courier;
  assert(
    ['pending', 'confirmed'].includes(order.status) &&
      (order.paymentMethod === 'cod' || order.paymentStatus === 'paid'),
    409,
    'Confirm payment or select a cash-on-delivery order before dispatch',
  );
  const buyer = order.customer,
    value = order.paymentMethod === 'cod' ? order.total : 0;
  if (provider !== 'shippo')
    assert(
      (buyer.country || 'BD') === 'BD' && currency(order.currency) === 'BDT',
      400,
      'Use a Bangladesh delivery address and BDT for this courier',
    );
  if (provider === 'shippo') {
    assert(order.paymentMethod !== 'cod', 400, 'Shippo requires a prepaid order');
    assert(
      order.ratesAt > new Date(Date.now() - days(1)) &&
        order.quotedRates?.some((rate) => rate.id === options.rateId),
      400,
      'Request rates and choose an available Shippo service',
    );
  }
  const pathaoCity = Number(options.city || buyer.pathaoCity),
    pathaoZone = Number(options.zone || buyer.pathaoZone);
  if (provider === 'pathao')
    assert(pathaoCity > 0 && pathaoZone > 0, 400, 'Choose a Pathao city and zone before dispatch');
  if (provider === 'redx')
    assert(Number(options.area) > 0 && trim(options.areaName, 100), 400, 'Choose a RedX delivery area');
  const lock = randomUUID();
  const claim = await database.collection('orders').updateOne(
    {
      _id: orderId,
      shopSlug: shop.slug,
      status: order.status,
      'courier.consignmentId': { $exists: false },
      courierLock: { $exists: false },
    },
    { $set: { courierLock: lock, courierLockAt: today() } },
  );
  assert(claim.modifiedCount, 409, 'A courier request was already sent or is awaiting reconciliation');
  let result;
  try {
    if (provider === 'steadfast') {
      const data = await steadfastRequest(cfg, '/create_order', {
        method: 'POST',
        body: JSON.stringify({
          invoice: String(order._id),
          recipient_name: buyer.name,
          recipient_phone: buyer.phone,
          recipient_address: buyer.address,
          cod_amount: value,
          note: 'ShopOS order',
        }),
      });
      const parcel = data.consignment;
      assert(parcel?.consignment_id, 502, 'Steadfast did not return a consignment');
      result = {
        consignmentId: String(parcel.consignment_id),
        trackingCode: parcel.tracking_code,
        status: parcel.status || 'created',
        trackingUrl: parcel.tracking_code
          ? `https://steadfast.com.bd/t/${encodeURIComponent(parcel.tracking_code)}`
          : '',
      };
    } else if (provider === 'pathao') {
      const data = await pathaoRequest(cfg, '/orders', {
        method: 'POST',
        body: JSON.stringify({
          store_id: Number(cfg.storeId),
          merchant_order_id: String(order._id),
          sender_name: shop.shipFrom?.name || shop.name,
          sender_phone: shop.shipFrom?.phone || undefined,
          recipient_name: buyer.name,
          recipient_phone: buyer.phone,
          recipient_address: buyer.address,
          recipient_city: pathaoCity,
          recipient_zone: pathaoZone,
          recipient_area: Number(options.area || buyer.pathaoArea) || undefined,
          delivery_type: 48,
          item_type: 2,
          item_quantity: order.items.reduce((sum, item) => sum + item.qty, 0),
          item_weight: Math.min(
            10,
            Math.max(
              0.5,
              order.items.reduce((sum, item) => sum + (item.weight || 0) * item.qty, 0),
            ),
          ),
          amount_to_collect: value,
          item_description: 'ShopOS order',
        }),
      });
      assert(data.data?.consignment_id, 502, 'Pathao did not return a consignment');
      result = {
        consignmentId: String(data.data.consignment_id),
        trackingCode: String(data.data.consignment_id),
        status: data.data.order_status || 'created',
      };
    } else if (provider === 'redx') {
      const data = await redxRequest(cfg, '/parcel', {
        method: 'POST',
        body: JSON.stringify({
          customer_name: buyer.name,
          customer_phone: buyer.phone,
          delivery_area: trim(options.areaName, 100),
          delivery_area_id: Number(options.area),
          customer_address: buyer.address,
          merchant_invoice_id: String(order._id),
          cash_collection_amount: String(value),
          parcel_weight: Math.round(
            Math.max(
              0.5,
              order.items.reduce((sum, item) => sum + (item.weight || 0) * item.qty, 0),
            ) * 1000,
          ),
          value: String(order.total),
          pickup_store_id: Number(cfg.storeId),
          instruction: 'ShopOS order',
        }),
      });
      const tracking = data.tracking_id || data.data?.tracking_id;
      assert(tracking, 502, 'RedX did not return a tracking ID');
      result = {
        consignmentId: String(tracking),
        trackingCode: String(tracking),
        status: 'created',
        trackingUrl: `https://redx.com.bd/track-parcel/?trackingId=${encodeURIComponent(tracking)}`,
      };
    } else {
      const data = await shippoRequest(cfg, '/transactions/', {
        method: 'POST',
        body: JSON.stringify({
          rate: options.rateId,
          label_file_type: 'PDF',
          async: false,
          metadata: String(order._id),
        }),
      });
      assert(data.status === 'SUCCESS' && data.object_id, 502, 'Shippo did not issue a shipping label');
      result = {
        consignmentId: data.object_id,
        trackingCode: data.tracking_number,
        trackingUrl: data.tracking_url_provider,
        labelUrl: data.label_url,
        status: data.tracking_status || 'created',
        carrier: order.quotedRates.find((rate) => rate.id === options.rateId)?.provider,
      };
    }
  } catch (error) {
    await database.collection('orders').updateOne(
      { _id: orderId, courierLock: lock },
      {
        $set: {
          courierIssue: `${provider}: verify the order in the provider dashboard before retrying.`,
        },
      },
    );
    throw error;
  }
  const courier = { provider, ...result, createdAt: today(), syncedAt: today() };
  await transaction(async (database, session) => {
    const changed = await database.collection('orders').updateOne(
      { _id: orderId, courierLock: lock },
      {
        $set: { courier, status: 'shipped', updatedAt: today() },
        $unset: { courierLock: '', courierLockAt: '', courierIssue: '' },
      },
      { session },
    );
    assert(changed.modifiedCount, 409, 'Courier request was superseded');
    await audit(
      database,
      shop.slug,
      options.actorId || 'worker',
      'courier.dispatched',
      String(orderId),
      session,
    );
    await queue(
      database,
      shop.slug,
      'order.message',
      { orderId: String(orderId), status: 'shipped' },
      today(),
      session,
    );
  });
  return courier;
}
app.post(
  '/shops/:slug/orders/:orderId/courier',
  route(async (req, res) => {
    const { shop, user } = await workspace(req, 'orders');
    res.json(
      await dispatchCourier(shop, recordId(req.params.orderId), req.body?.provider || 'steadfast', {
        ...req.body,
        actorId: user.id,
      }),
    );
  }),
);
app.post(
  '/shops/:slug/orders/:orderId/courier/unlock',
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req, 'owner');
    assert(req.body.checked === true, 400, 'Confirm the provider has no consignment for this order');
    const orderId = recordId(req.params.orderId);
    const result = await database.collection('orders').updateOne(
      {
        _id: orderId,
        shopSlug: shop.slug,
        courierLockAt: { $lt: new Date(Date.now() - 60_000) },
        'courier.consignmentId': { $exists: false },
      },
      { $unset: { courierLock: '', courierLockAt: '', courierIssue: '' } },
    );
    assert(result.modifiedCount, 409, 'No expired courier request to unlock');
    await audit(database, shop.slug, user.id, 'courier.unlocked', String(orderId));
    res.json({ ok: true });
  }),
);
async function syncCourier(shop, order) {
  const database = await db(),
    parcel = order.courier;
  const cfg = (await providerConfig(database, shop.slug))[parcel.provider];
  assert(providerReady(parcel.provider, cfg), 503, 'Connect the order courier before syncing');
  let status;
  if (parcel.provider === 'steadfast')
    status = (await steadfastRequest(cfg, `/status_by_cid/${encodeURIComponent(parcel.consignmentId)}`))
      .delivery_status;
  if (parcel.provider === 'pathao')
    status = (await pathaoRequest(cfg, `/orders/${encodeURIComponent(parcel.consignmentId)}/info`)).data
      ?.order_status;
  if (parcel.provider === 'redx') {
    const data = await redxRequest(cfg, `/parcel/track/${encodeURIComponent(parcel.consignmentId)}`);
    status = data.tracking?.[0]?.status || data.status || data.data?.status;
  }
  if (parcel.provider === 'shippo')
    status = (await shippoRequest(cfg, `/transactions/${encodeURIComponent(parcel.consignmentId)}/`))
      .tracking_status;
  assert(status, 502, 'Courier status is unavailable');
  const normalized = String(status).toLowerCase().replace(/[ -]/g, '_');
  if (
    order.status === 'shipped' &&
    ['delivered', 'partial_delivered'].includes(normalized) &&
    normalized !== 'partial_delivered'
  )
    await setOrderStatus(shop, order._id, 'delivered', 'courier');
  if (
    ['shipped', 'delivered'].includes(order.status) &&
    ['returned', 'return', 'return_to_sender', 'cancelled', 'canceled', 'delivery_failed'].includes(
      normalized,
    )
  )
    await setOrderStatus(shop, order._id, 'returned', 'courier');
  const updated = await database
    .collection('orders')
    .findOneAndUpdate(
      { _id: order._id },
      { $set: { 'courier.status': status, 'courier.syncedAt': today() } },
      { returnDocument: 'after' },
    );
  return { status: updated.status, paymentStatus: updated.paymentStatus, courier: updated.courier };
}
app.post(
  '/shops/:slug/orders/:orderId/courier/sync',
  route(async (req, res) => {
    const { database, shop } = await workspace(req, 'orders');
    const order = await database
      .collection('orders')
      .findOne({ _id: recordId(req.params.orderId), shopSlug: shop.slug });
    assert(order?.courier?.consignmentId, 404, 'This order has no consignment');
    res.json(await syncCourier(shop, order));
  }),
);

// Store settings, team permissions and domains
function settingsInput(input) {
  const set = {};
  for (const [key, max] of Object.entries({
    name: 100,
    description: 1500,
    timezone: 80,
    whatsapp: 30,
    senderEmail: 254,
  }))
    if (input[key] !== undefined) set[key] = trim(input[key], max);
  if (input.logoUrl !== undefined) set.logoUrl = webUrl(input.logoUrl);
  if (input.currency !== undefined) set.currency = currency(input.currency);
  if (input.country !== undefined) {
    assert(/^[A-Za-z]{2}$/.test(input.country), 400, 'Enter a two-letter country code');
    set.country = input.country.toUpperCase();
  }
  if (input.language !== undefined) set.language = input.language === 'bn' ? 'bn' : 'en';
  if (input.codEnabled !== undefined) set.codEnabled = yes(input.codEnabled);
  if (input.autoCourier !== undefined)
    set.autoCourier = ['steadfast', 'pathao'].includes(input.autoCourier) ? input.autoCourier : '';
  if (input.seo)
    set.seo = { title: trim(input.seo.title, 70), description: trim(input.seo.description, 180) };
  if (input.rates)
    set.rates = Object.fromEntries(
      Object.entries(input.rates)
        .filter(([code]) => currencies.includes(code))
        .map(([code, rate]) => [code, number(rate, `${code} rate`, 0.000001, 1_000_000)]),
    );
  if (input.shipping) {
    assert(
      Array.isArray(input.shipping) && input.shipping.length <= 40,
      400,
      'Use up to 40 delivery zones',
    );
    set.shipping = input.shipping.map((item) => ({
      id: /^[a-z0-9-]{1,60}$/i.test(item.id || '') ? item.id : randomUUID(),
      label: trim(item.label, 75) || 'Delivery',
      country: /^([A-Za-z]{2}|\*)$/.test(item.country) ? item.country.toUpperCase() : 'BD',
      postalPrefix: trim(item.postalPrefix, 20),
      base: number(item.base || 0, 'Base shipping charge', 0, 50_000),
      perKg: number(item.perKg || 0, 'Charge per kg', 0, 50_000),
    }));
  }
  if (input.shipFrom) set.shipFrom = parseCustomer(input.shipFrom);
  if (input.parcel)
    set.parcel = Object.fromEntries(
      ['length', 'width', 'height'].map((key) => [key, number(input.parcel[key], key, 1, 200)]),
    );
  if (input.collections) {
    assert(
      Array.isArray(input.collections) && input.collections.length <= 50,
      400,
      'Use up to 50 collections',
    );
    set.collections = input.collections
      .map((item) => ({
        id: item.id || randomUUID(),
        name: trim(item.name, 80),
        tags: (Array.isArray(item.tags) ? item.tags : String(item.tags || '').split(','))
          .map((tag) => trim(tag, 35))
          .filter(Boolean)
          .slice(0, 20),
      }))
      .filter((item) => item.name);
  }
  return set;
}
app.get(
  '/shops/:slug/settings',
  route(async (req, res) => {
    const { database, shop, role } = await workspace(req);
    const cfg = await providerConfig(database, shop.slug);
    const providers = Object.fromEntries(
      Object.entries(providerFields).map(([name, fields]) => [
        name,
        {
          configured: providerReady(name, cfg[name]),
          enabled: cfg[name]?.enabled !== false,
          fields:
            role === 'owner'
              ? Object.fromEntries(
                  fields.map((key) => [key, secretFields.has(key) ? undefined : cfg[name]?.[key]]),
                )
              : {},
        },
      ]),
    );
    headersNoStore(res).json({
      ...publicShop(shop),
      role,
      status: shop.status || 'active',
      autoCourier: shop.autoCourier || '',
      shipFrom: shop.shipFrom || null,
      parcel: shop.parcel,
      providers,
      rootDomain: env.SHOPOS_ROOT_DOMAIN || '',
      currencyOptions: currencies,
    });
  }),
);
app.patch(
  ['/shops/:slug/settings', '/shops/:slug'],
  shopFiles,
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req, 'owner');
    const set = settingsInput(req.body);
    if (set.currency && set.currency !== currency(shop.currency))
      assert(
        !(await database.collection('products').findOne({ shopSlug: shop.slug })),
        409,
        'Set the base currency before adding products. Use additional currencies for an existing catalog.',
      );
    if (req.files?.logo?.[0]) set.logoUrl = await uploadImage(req.files.logo[0]);
    const updated = await database
      .collection('shops')
      .findOneAndUpdate(
        { _id: shop._id },
        { $set: { ...set, updatedAt: today() } },
        { returnDocument: 'after' },
      );
    await audit(database, shop.slug, user.id, 'shop.settings_updated', shop.slug);
    res.json(publicShop(updated));
  }),
);
app.put(
  '/shops/:slug/providers/:provider',
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req, 'owner');
    const provider = req.params.provider,
      fields = providerFields[provider];
    assert(Array.isArray(fields), 404, 'Provider not found');
    const previous = await database.collection('providers').findOne({ shopSlug: shop.slug });
    const config = previous?.sealed ? decrypt(previous.sealed) : {};
    const next = { ...config[provider] };
    if (provider === 'stripe' && trim(req.body.secretKey, 600)) delete next.accountId;
    for (const key of fields) {
      if (key === 'accountId') continue;
      if (req.body[key] === undefined || (req.body[key] === '' && secretFields.has(key))) continue;
      next[key] =
        key === 'sandbox' ? yes(req.body[key]) : trim(req.body[key], key === 'endpoint' ? 1200 : 600);
    }
    next.enabled = yes(req.body.enabled, true);
    if (provider === 'stripe' && next.accountId && next.enabled) {
      assert(env.STRIPE_SECRET_KEY, 503, 'Configure the Stripe Connect platform keys first');
      const account = await stripeClient({ secretKey: env.STRIPE_SECRET_KEY }).accounts.retrieve(
        next.accountId,
      );
      assert(account.charges_enabled, 409, 'Finish Stripe Connect onboarding before enabling checkout');
    }
    if (['google', 'market'].includes(provider) && next.endpoint)
      next.endpoint = (await externalUrl(next.endpoint)).href;
    config[provider] = next;
    const filter = previous
      ? { _id: previous._id, sealed: previous.sealed }
      : { shopSlug: shop.slug, sealed: { $exists: false } };
    const result = await database
      .collection('providers')
      .updateOne(
        filter,
        { $set: { sealed: encrypt(config), updatedAt: today() } },
        { upsert: !previous },
      );
    assert(
      result.matchedCount || result.upsertedCount,
      409,
      'Provider settings changed in another tab. Reload and try again.',
    );
    await audit(database, shop.slug, user.id, 'provider.updated', provider);
    res.json({
      configured: providerReady(provider, (await providerConfig(database, shop.slug))[provider]),
    });
  }),
);
app.delete(
  '/shops/:slug/providers/:provider',
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req, 'owner');
    assert(Object.hasOwn(providerFields, req.params.provider), 404, 'Provider not found');
    const old = await database.collection('providers').findOne({ shopSlug: shop.slug });
    const config = old?.sealed ? decrypt(old.sealed) : {};
    config[req.params.provider] = { enabled: false };
    await database
      .collection('providers')
      .updateOne(
        { shopSlug: shop.slug, ...(old ? { sealed: old.sealed } : {}) },
        { $set: { sealed: encrypt(config), updatedAt: today() } },
        { upsert: !old },
      );
    await audit(database, shop.slug, user.id, 'provider.disconnected', req.params.provider);
    res.json({ ok: true });
  }),
);
app.get(
  '/shops/:slug/staff',
  route(async (req, res) => {
    const { database, shop } = await workspace(req, 'owner');
    res.json(
      (
        await database
          .collection('staff')
          .find({ shopSlug: shop.slug })
          .sort({ createdAt: -1 })
          .toArray()
      ).map(serialize),
    );
  }),
);
app.post(
  '/shops/:slug/staff',
  route(async (req, res) => {
    const { shop, user } = await workspace(req, 'owner');
    const address = email(req.body.email);
    assert(
      address && address !== user.email && roles.includes(req.body.role),
      400,
      'Enter a team email and select a role',
    );
    const result = await transaction(async (database, session) => {
      const prior = await database
        .collection('staff')
        .findOne({ shopSlug: shop.slug, email: address }, { session });
      if (!prior?.active) await capacity(database, shop, 'seats', 1, session);
      const item = await database.collection('staff').findOneAndUpdate(
        { shopSlug: shop.slug, email: address },
        {
          $set: { role: req.body.role, active: true, updatedAt: today() },
          $setOnInsert: { createdAt: today() },
        },
        { session, upsert: true, returnDocument: 'after' },
      );
      await audit(database, shop.slug, user.id, 'staff.invited', address, session);
      await queue(
        database,
        shop.slug,
        'email',
        {
          to: address,
          subject: `Join ${shop.name} on ShopOS`,
          text: `Sign in with this verified email to access ${shop.name}: ${clientUrl}/login`,
        },
        today(),
        session,
      );
      return item;
    });
    res.status(201).json(serialize(result));
  }),
);
app.delete(
  '/shops/:slug/staff/:staffId',
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req, 'owner');
    const result = await database
      .collection('staff')
      .updateOne(
        { _id: recordId(req.params.staffId), shopSlug: shop.slug },
        { $set: { active: false, updatedAt: today() } },
      );
    assert(result.matchedCount, 404, 'Team member not found');
    await audit(database, shop.slug, user.id, 'staff.revoked', req.params.staffId);
    res.json({ ok: true });
  }),
);
function domainHost(value) {
  const host = lower(value, 253).replace(/\.$/, '');
  assert(
    /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host),
    400,
    'Enter a hostname without https:// or a path',
  );
  return host;
}
app.get(
  '/domains/resolve',
  route(async (req, res) => {
    const host = domainHost(req.query.host),
      database = await db();
    const domain = await database.collection('domains').findOne({ host, verified: true });
    if (domain) {
      await findShop(database, domain.shopSlug, true);
      return res.json({ shopSlug: domain.shopSlug, pageSlug: domain.pageSlug || null });
    }
    const root = lower(env.SHOPOS_ROOT_DOMAIN, 253);
    assert(root && host.endsWith(`.${root}`), 404, 'Domain not found');
    const slug = host.slice(0, -root.length - 1);
    const shop = await findShop(database, slug, true);
    res.json({ shopSlug: shop.slug, pageSlug: null });
  }),
);
app.get(
  '/shops/:slug/domains',
  route(async (req, res) => {
    const { database, shop } = await workspace(req, 'owner');
    res.json(
      (await database.collection('domains').find({ shopSlug: shop.slug }).toArray()).map(serialize),
    );
  }),
);
app.post(
  '/shops/:slug/domains',
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req, 'owner');
    const host = domainHost(req.body.host),
      pageSlug = slugify(req.body.pageSlug);
    const root = lower(env.SHOPOS_ROOT_DOMAIN, 253);
    const canonical = new URL(clientUrl).hostname;
    assert(
      host !== canonical && (!root || (host !== root && !host.endsWith(`.${root}`))),
      400,
      'Use your own custom domain',
    );
    if (pageSlug)
      assert(
        await database.collection('landings').findOne({ shopSlug: shop.slug, slug: pageSlug }),
        404,
        'Landing page not found',
      );
    assert(
      (await database.collection('domains').countDocuments({ shopSlug: shop.slug })) < 20,
      409,
      'This shop has reached its domain limit',
    );
    const domain = {
      host,
      pageSlug,
      shopSlug: shop.slug,
      token: `shopos-${randomBytes(16).toString('hex')}`,
      verified: false,
      createdAt: today(),
    };
    await database.collection('domains').insertOne(domain);
    await audit(database, shop.slug, user.id, 'domain.created', host);
    res.status(201).json(serialize(domain));
  }),
);
app.post(
  '/shops/:slug/domains/:domainId/verify',
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req, 'owner');
    const item = await database
      .collection('domains')
      .findOne({ _id: recordId(req.params.domainId), shopSlug: shop.slug });
    assert(item, 404, 'Domain not found');
    const { resolveTxt } = await import('node:dns/promises');
    const records = await resolveTxt(`_shopos.${item.host}`).catch(() => []);
    assert(
      records.some((record) => record.join('') === item.token),
      409,
      'The verification TXT record has not been found. Check DNS and try again.',
    );
    await database
      .collection('domains')
      .updateOne({ _id: item._id }, { $set: { verified: true, verifiedAt: today() } });
    await audit(database, shop.slug, user.id, 'domain.verified', item.host);
    res.json({ verified: true });
  }),
);
app.delete(
  '/shops/:slug/domains/:domainId',
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req, 'owner');
    const result = await database
      .collection('domains')
      .findOneAndDelete({ _id: recordId(req.params.domainId), shopSlug: shop.slug });
    assert(result, 404, 'Domain not found');
    await audit(database, shop.slug, user.id, 'domain.removed', result.host);
    res.json({ ok: true });
  }),
);

// Platform billing is separate from customer checkout.
function platformStripe() {
  assert(
    env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET,
    503,
    'Set the platform Stripe keys to enable billing',
  );
  return stripeClient({ secretKey: env.STRIPE_SECRET_KEY });
}
const billingCurrency = () => currency(env.BILLING_CURRENCY, 'BDT');
app.get(
  '/shops/:slug/billing',
  route(async (req, res) => {
    const { database, shop } = await workspace(req, 'owner');
    const [catalog, invoices, products, pages, seats, transfer] = await Promise.all([
      plans(database),
      database
        .collection('invoices')
        .find({ shopSlug: shop.slug })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray(),
      database.collection('products').countDocuments({ shopSlug: shop.slug }),
      database.collection('landings').countDocuments({ shopSlug: shop.slug }),
      database.collection('staff').countDocuments({ shopSlug: shop.slug, active: true }),
      database.collection('storefrontUsage').findOne({ _id: transferKey(shop) }),
    ]);
    res.json({
      plan: effectivePlan(shop),
      trialEndsAt: shop.trialEndsAt,
      billing: {
        status: shop.billing?.status,
        cadence: shop.billing?.cadence,
        endsAt: shop.billing?.endsAt,
        hasCustomer: !!shop.billing?.customerId,
      },
      invoices: invoices.map(serialize),
      usage: { products, pages, seats: seats + 1, bandwidth: transfer?.bytes || 0 },
      plans: catalog,
      currency: billingCurrency(),
      available: !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET),
    });
  }),
);
app.post(
  '/shops/:slug/billing/checkout',
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req, 'owner');
    const planKey = trim(req.body.plan, 30),
      cadence = trim(req.body.cadence, 30);
    const plan = (await plans(database))[planKey];
    assert(
      planKey !== 'free' &&
        plan &&
        ['monthly', 'yearly', 'lifetime'].includes(cadence) &&
        Number(plan[cadence]) > 0,
      400,
      'Choose a paid plan and billing interval',
    );
    assert(
      !shop.billing?.subscriptionId ||
        !['active', 'trialing', 'past_due'].includes(shop.billing?.status),
      409,
      'Open the billing portal to manage the current subscription',
    );
    assert(shop.billing?.status !== 'lifetime', 409, 'This shop already has a lifetime plan');
    const mode = cadence === 'lifetime' ? 'payment' : 'subscription';
    const metadata = { purpose: 'billing', shopSlug: shop.slug, plan: planKey, cadence };
    const returnUrl = `${clientUrl}/dashboard/settings/billing?shop=${encodeURIComponent(shop.slug)}`;
    const checkout = await platformStripe().checkout.sessions.create(
      {
        mode,
        customer: shop.billing?.customerId || undefined,
        customer_email: shop.billing?.customerId ? undefined : user.email,
        metadata,
        subscription_data: mode === 'subscription' ? { metadata } : undefined,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: billingCurrency().toLowerCase(),
              unit_amount: minor(plan[cadence]),
              product_data: { name: `ShopOS ${plan.name}` },
              recurring:
                mode === 'subscription'
                  ? { interval: cadence === 'monthly' ? 'month' : 'year' }
                  : undefined,
            },
          },
        ],
        success_url: `${returnUrl}&checkout={CHECKOUT_SESSION_ID}`,
        cancel_url: returnUrl,
      },
      { idempotencyKey: `bill-${shop._id}-${planKey}-${cadence}-${Math.floor(Date.now() / 300_000)}` },
    );
    res.json({ url: checkout.url });
  }),
);
async function applyBillingCheckout(database, checkout) {
  const { shopSlug, plan, cadence } = checkout.metadata || {};
  if (checkout.status !== 'complete' || checkout.payment_status !== 'paid' || !defaultPlans[plan])
    return false;
  const shop = await database.collection('shops').findOne({ slug: shopSlug });
  if (!shop) return false;
  const subscription = checkout.subscription
    ? await platformStripe().subscriptions.retrieve(String(checkout.subscription))
    : null;
  const end = subscription?.items?.data?.[0]?.current_period_end || subscription?.current_period_end;
  const billing = {
    plan,
    cadence,
    status: cadence === 'lifetime' ? 'lifetime' : subscription?.status || 'active',
    customerId: checkout.customer ? String(checkout.customer) : shop.billing?.customerId,
    subscriptionId: subscription?.id,
    endsAt: end ? new Date(end * 1000) : null,
    checkoutId: checkout.id,
  };
  await database.collection('shops').updateOne({ slug: shopSlug }, { $set: { billing } });
  if (cadence === 'lifetime')
    await database.collection('invoices').updateOne(
      { _id: checkout.id },
      {
        $set: {
          shopSlug,
          amount: money(checkout.amount_total),
          currency: checkout.currency.toUpperCase(),
          status: 'paid',
          createdAt: new Date(checkout.created * 1000),
        },
      },
      { upsert: true },
    );
  return true;
}
async function updateBillingEvent(database, event) {
  const item = event.data.object;
  const shop = await database.collection('shops').findOne({
    'billing.customerId': String(item.customer || ''),
    ...(item.object === 'subscription' ? { 'billing.subscriptionId': item.id } : {}),
  });
  if (!shop) return;
  const eventAt = new Date(event.created * 1000);
  if (item.object === 'subscription') {
    const end = item.items?.data?.[0]?.current_period_end || item.current_period_end;
    await database.collection('shops').updateOne(
      {
        _id: shop._id,
        'billing.subscriptionId': item.id,
        $or: [{ 'billing.eventAt': { $exists: false } }, { 'billing.eventAt': { $lte: eventAt } }],
      },
      {
        $set: {
          'billing.status': item.status,
          'billing.endsAt': end ? new Date(end * 1000) : null,
          'billing.eventAt': eventAt,
        },
      },
    );
  } else {
    const subscriptionId = item.parent?.subscription_details?.subscription || item.subscription;
    if (subscriptionId && subscriptionId !== shop.billing.subscriptionId) return;
    await database.collection('invoices').updateOne(
      { _id: item.id },
      {
        $set: {
          shopSlug: shop.slug,
          amount: money(item.amount_due),
          currency: item.currency.toUpperCase(),
          status: item.status,
          url: item.hosted_invoice_url,
          pdf: item.invoice_pdf,
          createdAt: new Date(item.created * 1000),
        },
      },
      { upsert: true },
    );
    if (event.type === 'invoice.payment_failed') {
      await notice(
        database,
        shop.slug,
        'billing',
        'Subscription payment failed',
        'Open Billing to update your payment method.',
      );
      if (shop.ownerEmail)
        await queue(database, shop.slug, 'email', {
          to: shop.ownerEmail,
          subject: 'ShopOS subscription payment failed',
          text: `Update your payment method in ${clientUrl}/dashboard/settings/billing?shop=${shop.slug}. Stripe handles scheduled retries configured in your account.`,
        });
    }
  }
}
app.post(
  '/shops/:slug/billing/verify',
  route(async (req, res) => {
    const { database, shop } = await workspace(req, 'owner');
    const checkout = await platformStripe().checkout.sessions.retrieve(trim(req.body.checkoutId, 200));
    assert(
      checkout.metadata?.shopSlug === shop.slug && checkout.metadata?.purpose === 'billing',
      404,
      'Billing checkout not found',
    );
    res.json({ paid: await applyBillingCheckout(database, checkout) });
  }),
);
app.post(
  '/shops/:slug/billing/portal',
  route(async (req, res) => {
    const { shop } = await workspace(req, 'owner');
    assert(shop.billing?.customerId, 409, 'There is no Stripe billing account for this shop yet');
    const portal = await platformStripe().billingPortal.sessions.create({
      customer: shop.billing.customerId,
      return_url: `${clientUrl}/dashboard/settings/billing?shop=${shop.slug}`,
    });
    res.json({ url: portal.url });
  }),
);
app.post(
  '/shops/:slug/stripe/connect',
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req, 'owner');
    assert(
      env.STRIPE_SECRET_KEY && env.STRIPE_CONNECT_WEBHOOK_SECRET,
      503,
      'Configure Stripe Connect on the platform first',
    );
    const stripe = stripeClient({ secretKey: env.STRIPE_SECRET_KEY });
    const old = await database.collection('providers').findOne({ shopSlug: shop.slug });
    const cfg = old?.sealed ? decrypt(old.sealed) : {};
    if (!cfg.stripe?.accountId) {
      encryptionKey();
      const account = await stripe.accounts.create(
        {
          type: 'express',
          country: trim(req.body.country, 2).toUpperCase() || undefined,
          email: user.email,
          metadata: { shopSlug: shop.slug },
          capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        },
        { idempotencyKey: `connect-${shop._id}` },
      );
      cfg.stripe = { accountId: account.id, enabled: false };
      await database
        .collection('providers')
        .updateOne(
          { shopSlug: shop.slug, ...(old ? { sealed: old.sealed } : {}) },
          { $set: { sealed: encrypt(cfg), updatedAt: today() } },
          { upsert: !old },
        );
    }
    const returnUrl = `${clientUrl}/dashboard/settings/payments?shop=${shop.slug}`;
    const link = await stripe.accountLinks.create({
      account: cfg.stripe.accountId,
      type: 'account_onboarding',
      refresh_url: returnUrl,
      return_url: `${returnUrl}&connect=1`,
    });
    res.json({ url: link.url });
  }),
);
app.post(
  '/shops/:slug/stripe/verify',
  route(async (req, res) => {
    const { database, shop } = await workspace(req, 'owner');
    const old = await database.collection('providers').findOne({ shopSlug: shop.slug });
    const cfg = old?.sealed ? decrypt(old.sealed) : {};
    assert(cfg.stripe?.accountId && env.STRIPE_SECRET_KEY, 400, 'Start Stripe Connect onboarding first');
    const account = await stripeClient({ secretKey: env.STRIPE_SECRET_KEY }).accounts.retrieve(
      cfg.stripe.accountId,
    );
    cfg.stripe.enabled = !!account.charges_enabled;
    await database
      .collection('providers')
      .updateOne(
        { _id: old._id, sealed: old.sealed },
        { $set: { sealed: encrypt(cfg), updatedAt: today() } },
      );
    res.json({ enabled: cfg.stripe.enabled, payoutsEnabled: !!account.payouts_enabled });
  }),
);
app.get(
  '/shops/:slug/payouts',
  route(async (req, res) => {
    const { database, shop } = await workspace(req, 'owner');
    const cfg = (await providerConfig(database, shop.slug)).stripe;
    if (!providerReady('stripe', cfg)) return res.json({ available: false, balance: null, payouts: [] });
    const stripe = stripeClient(cfg);
    const [balance, payouts] = await Promise.all([
      stripe.balance.retrieve({}, stripeOptions(cfg)),
      stripe.payouts.list({ limit: 30 }, stripeOptions(cfg)),
    ]);
    const normalize = (item) => ({ amount: money(item.amount), currency: item.currency.toUpperCase() });
    res.json({
      available: true,
      balance: { available: balance.available.map(normalize), pending: balance.pending.map(normalize) },
      payouts: payouts.data.map((item) => ({
        id: item.id,
        ...normalize(item),
        arrival: new Date(item.arrival_date * 1000),
        status: item.status,
      })),
    });
  }),
);

// Published landing pages, A/B assignments, and consent-aware tracking
function defaultSections(template, title) {
  const standard = [
    { id: randomUUID(), type: 'hero', title, body: 'Add a short description of the product.' },
    { id: randomUUID(), type: 'features', title: 'Product highlights', items: [] },
    { id: randomUUID(), type: 'faq', title: 'Questions', items: [] },
    { id: randomUUID(), type: 'order', title: 'Place your order' },
  ];
  if (template === 'launch')
    standard.splice(2, 0, {
      id: randomUUID(),
      type: 'countdown',
      title: 'Launch offer ends',
      endsAt: null,
    });
  if (template === 'story')
    standard.splice(2, 0, {
      id: randomUUID(),
      type: 'testimonials',
      title: 'Customer feedback',
      items: [],
    });
  return standard;
}
function landingSections(items) {
  assert(
    Array.isArray(items) && items.length >= 1 && items.length <= 18,
    400,
    'Add between one and 18 sections',
  );
  assert(
    items.every((item) => sectionTypes.includes(item.type)),
    400,
    'Choose an available section type',
  );
  const used = new Set();
  return items.map((item) => {
    const id = /^[a-z0-9-]{1,60}$/i.test(item.id || '') && !used.has(item.id) ? item.id : randomUUID();
    used.add(id);
    return {
      id,
      type: item.type,
      title: trim(item.title, 150),
      body: trim(item.body, 3000),
      image: webUrl(item.image),
      endsAt: dateValue(item.endsAt),
      items: Array.isArray(item.items)
        ? item.items
            .slice(0, 15)
            .map((line) => ({ title: trim(line.title, 120), body: trim(line.body, 700) }))
            .filter((line) => line.title || line.body)
        : [],
    };
  });
}
function landingInput(input, prior) {
  const title = trim(input.title ?? prior?.title, 140);
  const slug = slugify(input.slug ?? prior?.slug ?? title);
  assert(title && slug, 400, 'Add a page title and URL slug');
  const template = ['cod', 'launch', 'story'].includes(input.template)
    ? input.template
    : prior?.template || 'cod';
  const a = landingSections(input.variants?.a || prior?.variants?.a || defaultSections(template, title));
  const b = landingSections(input.variants?.b || prior?.variants?.b || a);
  return {
    title,
    slug,
    template,
    productId: recordId(input.productId ?? prior?.productId?.toString()),
    variants: { a, b },
    abEnabled: yes(input.abEnabled, prior?.abEnabled || false),
    split: number(input.split ?? prior?.split ?? 50, 'Variant B traffic', 1, 99, true),
    seoTitle: trim(input.seoTitle ?? prior?.seoTitle, 70),
    seoDescription: trim(input.seoDescription ?? prior?.seoDescription, 180),
    updatedAt: today(),
  };
}
app.get(
  '/shops/:slug/landings',
  route(async (req, res) => {
    const { database, shop } = await workspace(req);
    res.json(
      (
        await database
          .collection('landings')
          .find({ shopSlug: shop.slug })
          .sort({ updatedAt: -1 })
          .limit(100)
          .toArray()
      ).map(serialize),
    );
  }),
);
app.post(
  '/shops/:slug/landings',
  route(async (req, res) => {
    const { shop, user } = await workspace(req, 'manage');
    const item = { ...landingInput(req.body), shopSlug: shop.slug, status: 'draft', createdAt: today() };
    await transaction(async (database, session) => {
      assert(
        await database
          .collection('products')
          .findOne({ _id: item.productId, shopSlug: shop.slug }, { session }),
        404,
        'Product not found',
      );
      await capacity(database, shop, 'pages', 1, session);
      await database.collection('landings').insertOne(item, { session });
      await audit(database, shop.slug, user.id, 'landing.created', item.slug, session);
    });
    res.status(201).json(serialize(item));
  }),
);
app.put(
  '/shops/:slug/landings/:pageId',
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req, 'manage');
    const filter = { _id: recordId(req.params.pageId), shopSlug: shop.slug };
    const previous = await database.collection('landings').findOne(filter);
    assert(previous, 404, 'Landing page not found');
    const set = landingInput(req.body, previous);
    if (previous.published)
      assert(set.slug === previous.slug, 409, 'Keep the URL slug of a published page');
    const product = await database
      .collection('products')
      .findOne({ _id: set.productId, shopSlug: shop.slug });
    assert(product, 404, 'Product not found');
    if (req.body.publish === true) {
      assert(
        product.active !== false && product.moderation !== 'hidden',
        409,
        'Publish the linked product first',
      );
      set.status = 'published';
      set.published = { ...set, publishedAt: today() };
    }
    if (req.body.unpublish === true) set.status = 'draft';
    const updated = await database
      .collection('landings')
      .findOneAndUpdate(
        { ...filter, updatedAt: previous.updatedAt },
        { $set: set },
        { returnDocument: 'after' },
      );
    assert(updated, 409, 'This page changed in another tab. Reload and try again.');
    await audit(
      database,
      shop.slug,
      user.id,
      req.body.publish === true ? 'landing.published' : 'landing.updated',
      updated.slug,
    );
    res.json(serialize(updated));
  }),
);
app.delete(
  '/shops/:slug/landings/:pageId',
  route(async (req, res) => {
    const { shop, user } = await workspace(req, 'manage');
    await transaction(async (database, session) => {
      const page = await database
        .collection('landings')
        .findOneAndDelete({ _id: recordId(req.params.pageId), shopSlug: shop.slug }, { session });
      assert(page, 404, 'Landing page not found');
      await database
        .collection('domains')
        .deleteMany({ shopSlug: shop.slug, pageSlug: page.slug }, { session });
      await audit(database, shop.slug, user.id, 'landing.deleted', page.slug, session);
    });
    res.json({ ok: true });
  }),
);
function chooseVariant(page, visitor) {
  if (!page.abEnabled || !visitor) return 'a';
  return Number.parseInt(hash(`${page.slug}:${visitor}`).slice(0, 8), 16) % 100 < page.split ? 'b' : 'a';
}
async function landingAttribution(database, shopSlug, pageSlug, _variant, visitor) {
  if (!pageSlug) return null;
  const item = await database
    .collection('landings')
    .findOne({ shopSlug, slug: slugify(pageSlug), status: 'published' });
  return item?.published
    ? { slug: item.slug, variant: chooseVariant(item.published, trim(visitor, 100)) }
    : null;
}
app.get(
  '/shops/:slug/pages',
  route(async (req, res) => {
    const database = await db();
    await findShop(database, req.params.slug, true);
    res.json(
      await database
        .collection('landings')
        .find(
          { shopSlug: req.params.slug, status: 'published' },
          { projection: { _id: 0, slug: 1, updatedAt: 1, 'published.title': 1 } },
        )
        .limit(100)
        .toArray(),
    );
  }),
);
app.get(
  '/shops/:slug/pages/:pageSlug',
  route(async (req, res) => {
    const database = await db();
    const shop = await findShop(database, req.params.slug, true);
    const record = await database
      .collection('landings')
      .findOne({ shopSlug: shop.slug, slug: req.params.pageSlug, status: 'published' });
    const page = record?.published;
    assert(page, 404, 'Landing page not found');
    const product = await database.collection('products').findOne({
      _id: page.productId,
      shopSlug: shop.slug,
      active: { $ne: false },
      moderation: { $ne: 'hidden' },
    });
    assert(product, 404, 'This product is unavailable');
    const variant = chooseVariant(page, trim(req.query.visitor, 100));
    await storefrontResponse(database, shop, req, headersNoStore(res), {
      slug: page.slug,
      title: page.title,
      seoTitle: page.seoTitle,
      seoDescription: page.seoDescription,
      abEnabled: page.abEnabled,
      variant,
      sections: page.variants[variant],
      product: publicProduct(product),
    });
  }),
);
const publicEventNames = ['PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout'];
async function recordEvent(database, shopSlug, event, session) {
  const at = today();
  const name = event.name;
  const eventId = trim(event.eventId, 110);
  if (!event.consent || !eventId) return false;
  const result = await database.collection('events').updateOne(
    { shopSlug, eventId },
    {
      $setOnInsert: {
        shopSlug,
        eventId,
        name,
        visitor: trim(event.visitor, 100),
        channel: trim(event.channel, 40) || 'direct',
        pageSlug: event.pageSlug || '',
        variant: event.variant || '',
        value: event.value || 0,
        currency: currency(event.currency),
        createdAt: at,
      },
    },
    { upsert: true, session },
  );
  if (!result.upsertedCount) return false;
  const customer = event.customer;
  const hints = {
    emailHash: customer?.email ? hash(lower(customer.email)) : undefined,
    phoneHash: customer?.phone
      ? hash(customer.phone.replace(/\D/g, '').replace(/^0(?=1\d{9}$)/, '880'))
      : undefined,
    fbp: trim(event.fbp, 120) || undefined,
    fbc: trim(event.fbc, 150) || undefined,
    externalId: event.visitor ? hash(event.visitor) : undefined,
  };
  const cfg = await providerConfig(database, shopSlug);
  const destinations = ['meta', 'google', 'tiktok'].filter((key) => providerReady(key, cfg[key]));
  for (const provider of destinations)
    await queue(
      database,
      shopSlug,
      `tracking.${provider}`,
      {
        name,
        eventId,
        epoch: Math.floor(at.getTime() / 1000),
        url: trim(event.url, 1500),
        value: event.value || 0,
        currency: currency(event.currency),
        ...hints,
      },
      at,
      session,
    );
  return true;
}
app.post(
  '/shops/:slug/events',
  route(async (req, res) => {
    const database = await db(),
      shop = await findShop(database, req.params.slug, true);
    const data = req.body;
    assert(
      publicEventNames.includes(data.name) &&
        /^[\w-]{12,110}$/.test(data.eventId || '') &&
        /^[\w-]{12,100}$/.test(data.visitor || ''),
      400,
      'Invalid analytics event',
    );
    if (data.consent !== true) return res.status(202).json({ accepted: false });
    const attribution = await landingAttribution(database, shop.slug, data.pageSlug, null, data.visitor);
    const allowedChannels = [
      'direct',
      'facebook',
      'instagram',
      'google',
      'tiktok',
      'email',
      'affiliate',
      'referral',
    ];
    const channel = allowedChannels.includes(data.channel) ? data.channel : 'referral';
    let url = `${clientUrl}/shops/${shop.slug}`;
    if (data.url) {
      const received = new URL(webUrl(data.url));
      if (
        received.origin === new URL(clientUrl).origin ||
        (await database
          .collection('domains')
          .findOne({ shopSlug: shop.slug, host: received.hostname, verified: true }))
      )
        url = `${received.origin}${received.pathname}`;
    }
    const accepted = await recordEvent(database, shop.slug, {
      ...data,
      url,
      channel,
      pageSlug: attribution?.slug,
      variant: attribution?.variant,
      customer: undefined,
    });
    res.status(202).json({ accepted });
  }),
);
async function sendTracking(provider, cfg, data) {
  if (provider === 'meta') {
    assert(/^\d{5,30}$/.test(cfg.pixelId), 400, 'Invalid Meta pixel ID');
    const version = /^v\d{2}\.\d+$/.test(env.META_GRAPH_VERSION || '')
      ? env.META_GRAPH_VERSION
      : 'v24.0';
    const result = await requestJson(
      `https://graph.facebook.com/${version}/${cfg.pixelId}/events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify({
          data: [
            {
              event_name: data.name,
              event_id: data.eventId,
              event_time: data.epoch,
              action_source: 'website',
              event_source_url: data.url || undefined,
              user_data: {
                em: data.emailHash ? [data.emailHash] : undefined,
                ph: data.phoneHash ? [data.phoneHash] : undefined,
                external_id: data.externalId ? [data.externalId] : undefined,
                fbp: data.fbp,
                fbc: data.fbc,
              },
              custom_data: { currency: data.currency, value: data.value },
            },
          ],
          test_event_code: cfg.testCode || undefined,
        }),
      },
      'Meta Conversions API',
    );
    assert(result.events_received > 0, 502, 'Meta did not accept the event');
  } else if (provider === 'tiktok') {
    const events = {
      PageView: 'PageView',
      ViewContent: 'ViewContent',
      AddToCart: 'AddToCart',
      InitiateCheckout: 'InitiateCheckout',
      Purchase: 'CompletePayment',
    };
    const result = await requestJson(
      'https://business-api.tiktok.com/open_api/v1.3/event/track/',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Access-Token': cfg.token },
        body: JSON.stringify({
          event_source: 'web',
          event_source_id: cfg.pixelId,
          test_event_code: cfg.testCode || undefined,
          data: [
            {
              event: events[data.name],
              event_time: data.epoch,
              event_id: data.eventId,
              user: { email: data.emailHash, phone: data.phoneHash, external_id: data.externalId },
              page: { url: data.url },
              properties: { currency: data.currency, value: data.value },
            },
          ],
        }),
      },
      'TikTok Events API',
    );
    assert(result.code === 0, 502, 'TikTok did not accept the event');
  } else {
    const endpoint = await externalUrl(cfg.endpoint);
    endpoint.searchParams.set('measurement_id', cfg.measurementId);
    endpoint.searchParams.set('api_secret', cfg.apiSecret);
    const names = {
      PageView: 'page_view',
      ViewContent: 'view_item',
      AddToCart: 'add_to_cart',
      InitiateCheckout: 'begin_checkout',
      Purchase: 'purchase',
    };
    await publicRequest(
      endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: data.externalId || data.eventId,
          events: [
            {
              name: names[data.name],
              params: {
                event_id: data.eventId,
                transaction_id: data.name === 'Purchase' ? data.eventId : undefined,
                value: data.value,
                currency: data.currency,
                page_location: data.url,
              },
            },
          ],
        }),
      },
      'Google server tagging',
    );
  }
}
app.get(
  '/shops/:slug/analytics',
  route(async (req, res) => {
    const { database, shop } = await workspace(req);
    const range = [7, 14, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const since = new Date(Date.now() - days(range - 1));
    since.setUTCHours(0, 0, 0, 0);
    const cur = currency(shop.currency);
    const [orders, events, costs] = await Promise.all([
      database
        .collection('orders')
        .find(
          { shopSlug: shop.slug, createdAt: { $gte: since } },
          {
            projection: {
              customer: 1,
              customerId: 1,
              items: 1,
              status: 1,
              paymentStatus: 1,
              currency: 1,
              total: 1,
              totalBase: 1,
              pageSlug: 1,
              pageVariant: 1,
              createdAt: 1,
            },
          },
        )
        .limit(30_000)
        .toArray(),
      database
        .collection('events')
        .find({ shopSlug: shop.slug, createdAt: { $gte: since } })
        .limit(80_000)
        .toArray(),
      database
        .collection('adSpend')
        .find({ shopSlug: shop.slug, date: { $gte: since } })
        .toArray(),
    ]);
    const series = Object.fromEntries(
      Array.from({ length: range }, (_, index) => [
        new Date(since.getTime() + days(index)).toISOString().slice(0, 10),
        { orders: 0, revenue: 0, sessions: 0 },
      ]),
    );
    const byProduct = new Map(),
      channels = new Map(),
      variants = new Map();
    const people = new Map(),
      sessions = new Set(),
      converted = new Set();
    let revenue = 0,
      paidOrders = 0,
      openOrders = 0;
    for (const order of orders) {
      const daily = series[order.createdAt.toISOString().slice(0, 10)];
      if (daily) daily.orders++;
      if (['pending', 'confirmed', 'shipped'].includes(order.status)) openOrders++;
      const who = order.customerId || order.customer?.email || order.customer?.phone;
      if (who && !['cancelled', 'returned'].includes(order.status))
        people.set(who, (people.get(who) || 0) + 1);
      if (order.paymentStatus === 'paid' && !['cancelled', 'returned'].includes(order.status)) {
        const amount = order.totalBase ?? (currency(order.currency) === cur ? order.total : 0);
        paidOrders++;
        revenue += amount;
        if (daily) daily.revenue += amount;
        for (const line of order.items) {
          const key = String(line.productId);
          const item = byProduct.get(key) || { id: key, name: line.name, units: 0, revenue: 0 };
          item.units += line.qty;
          item.revenue += ((line.baseMinor ?? minor(line.price)) * line.qty) / 100;
          byProduct.set(key, item);
        }
      }
    }
    for (const event of events) {
      const date = event.createdAt.toISOString().slice(0, 10);
      const channel = channels.get(event.channel) || {
        channel: event.channel,
        sessions: new Set(),
        orders: 0,
        revenue: 0,
        currencies: {},
        spend: 0,
      };
      const session = `${event.visitor}:${date}`;
      if (event.name === 'PageView' && event.visitor && !sessions.has(session)) {
        sessions.add(session);
        if (series[date]) series[date].sessions++;
      }
      if (event.name === 'PageView' && event.visitor) channel.sessions.add(session);
      if (event.name === 'Purchase') {
        channel.orders++;
        if (event.visitor) converted.add(session);
        channel.currencies[event.currency] = (channel.currencies[event.currency] || 0) + event.value;
        if (event.currency === cur) channel.revenue += event.value;
      }
      channels.set(event.channel, channel);
      if (event.pageSlug) {
        const key = `${event.pageSlug}:${event.variant}`;
        const item = variants.get(key) || {
          page: event.pageSlug,
          variant: event.variant,
          visitors: new Set(),
          purchases: 0,
        };
        if (event.name === 'PageView' && event.visitor) item.visitors.add(event.visitor);
        if (event.name === 'Purchase') item.purchases++;
        variants.set(key, item);
      }
    }
    for (const item of costs) {
      const channel = channels.get(item.channel) || {
        channel: item.channel,
        sessions: new Set(),
        orders: 0,
        revenue: 0,
        currencies: {},
        spend: 0,
      };
      channel.spend += item.amount;
      channels.set(item.channel, channel);
    }
    const conversions = [...converted].filter((key) => sessions.has(key)).length;
    res.json({
      range,
      currency: cur,
      revenue,
      orders: orders.length,
      paidOrders,
      openOrders,
      customers: people.size,
      repeatCustomers: [...people.values()].filter((value) => value > 1).length,
      sessions: sessions.size,
      conversions,
      conversionRate: sessions.size ? (conversions / sessions.size) * 100 : null,
      series: Object.entries(series).map(([date, values]) => ({ date, ...values })),
      topProducts: [...byProduct.values()].sort((a, b) => b.units - a.units).slice(0, 8),
      channels: [...channels.values()].map((item) => ({
        ...item,
        sessions: item.sessions.size,
        roas: item.spend ? item.revenue / item.spend : null,
      })),
      variants: [...variants.values()].map((item) => ({ ...item, visitors: item.visitors.size })),
      limited: orders.length >= 30_000 || events.length >= 80_000,
    });
  }),
);
app.post(
  '/shops/:slug/analytics/spend',
  route(async (req, res) => {
    const { database, shop } = await workspace(req, 'manage');
    const channel = lower(req.body.channel, 40),
      date = dateValue(req.body.date);
    assert(
      ['facebook', 'instagram', 'google', 'tiktok', 'email', 'affiliate', 'referral', 'direct'].includes(
        channel,
      ) && date,
      400,
      'Choose a channel and date',
    );
    date.setUTCHours(0, 0, 0, 0);
    const amount = number(req.body.amount, 'Spend', 0, 10_000_000);
    await database
      .collection('adSpend')
      .updateOne(
        { _id: `${shop.slug}:${channel}:${date.toISOString().slice(0, 10)}` },
        { $set: { shopSlug: shop.slug, channel, date, amount } },
        { upsert: true },
      );
    res.json({ ok: true });
  }),
);
app.get(
  '/shops/:slug/customers',
  route(async (req, res) => {
    const { database, shop } = await workspace(req);
    const orders = await database
      .collection('orders')
      .find({ shopSlug: shop.slug, status: { $nin: ['cancelled', 'returned'] } })
      .sort({ createdAt: -1 })
      .limit(3000)
      .toArray();
    const people = new Map();
    for (const order of orders) {
      const buyer = order.customer;
      const id = buyer.email || buyer.phone;
      if (!id) continue;
      const row = people.get(id) || {
        id,
        name: buyer.name,
        email: buyer.email,
        phone: buyer.phone,
        orders: 0,
        paid: 0,
        lastOrder: order.createdAt,
      };
      row.orders++;
      if (order.paymentStatus === 'paid')
        row.paid +=
          order.totalBase ?? (currency(order.currency) === currency(shop.currency) ? order.total : 0);
      people.set(id, row);
    }
    res.json({ currency: currency(shop.currency), customers: [...people.values()].slice(0, 200) });
  }),
);

// Promotions, reviews and affiliate attribution
app.get(
  '/shops/:slug/discounts',
  route(async (req, res) => {
    const { database, shop } = await workspace(req);
    res.json(
      (
        await database
          .collection('discounts')
          .find({ shopSlug: shop.slug })
          .sort({ createdAt: -1 })
          .limit(100)
          .toArray()
      ).map(serialize),
    );
  }),
);
app.post(
  '/shops/:slug/discounts',
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req, 'manage');
    const code = trim(req.body.code, 32).toUpperCase(),
      type = req.body.type;
    assert(
      /^[A-Z0-9_-]{3,32}$/.test(code) && campaignTypes.includes(type),
      400,
      'Enter a code and campaign type',
    );
    const startsAt = dateValue(req.body.startsAt, today()),
      endsAt = dateValue(req.body.endsAt);
    assert(!endsAt || endsAt > startsAt, 400, 'The end date must be after the start date');
    const productIds = [
      ...new Set(
        (Array.isArray(req.body.productIds) ? req.body.productIds : [])
          .slice(0, 30)
          .map((value) => String(recordId(value))),
      ),
    ];
    if (productIds.length)
      assert(
        (await database
          .collection('products')
          .countDocuments({ _id: { $in: productIds.map(recordId) }, shopSlug: shop.slug })) ===
          productIds.length,
        400,
        'A selected product is not in this shop',
      );
    const item = {
      shopSlug: shop.slug,
      code,
      type,
      productIds,
      value: number(req.body.value, 'Discount', 0.01, type === 'fixed' ? 100_000 : 100),
      minSubtotal: number(req.body.minSubtotal || 0, 'Minimum subtotal', 0, 1_000_000),
      minQuantity: number(req.body.minQuantity || 2, 'Bundle quantity', 1, 100, true),
      maxUses: number(req.body.maxUses || 0, 'Maximum uses', 0, 100_000, true),
      uses: 0,
      startsAt,
      endsAt,
      active: true,
      automatic: ['flash', 'bundle'].includes(type) && yes(req.body.automatic, true),
      createdAt: today(),
    };
    await database.collection('discounts').insertOne(item);
    await audit(database, shop.slug, user.id, 'discount.created', code);
    res.status(201).json(serialize(item));
  }),
);
app.patch(
  '/shops/:slug/discounts/:itemId',
  route(async (req, res) => {
    const { database, shop } = await workspace(req, 'manage');
    const item = await database
      .collection('discounts')
      .findOneAndUpdate(
        { _id: recordId(req.params.itemId), shopSlug: shop.slug },
        { $set: { active: yes(req.body.active) } },
        { returnDocument: 'after' },
      );
    assert(item, 404, 'Discount not found');
    res.json(serialize(item));
  }),
);
app.get(
  '/shops/:slug/affiliates',
  route(async (req, res) => {
    const { database, shop } = await workspace(req, 'manage');
    const list = await database
      .collection('affiliates')
      .find({ shopSlug: shop.slug })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    const stats = await database
      .collection('orders')
      .aggregate([
        {
          $match: {
            shopSlug: shop.slug,
            affiliateId: { $exists: true },
            paymentStatus: 'paid',
            status: { $nin: ['cancelled', 'returned'] },
          },
        },
        {
          $group: {
            _id: { partner: '$affiliateId', currency: '$currency' },
            orders: { $sum: 1 },
            commission: { $sum: '$affiliateCommission' },
          },
        },
      ])
      .toArray();
    res.json(
      list.map((item) => ({
        ...serialize(item),
        results: stats
          .filter((row) => String(row._id.partner) === String(item._id))
          .map((row) => ({
            currency: row._id.currency,
            orders: row.orders,
            commission: row.commission,
          })),
      })),
    );
  }),
);
app.post(
  '/shops/:slug/affiliates',
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req, 'manage');
    const code = slugify(req.body.code || req.body.name),
      name = trim(req.body.name, 100),
      address = email(req.body.email);
    assert(code.length >= 3 && name && address, 400, 'Enter a partner name, email and referral code');
    const item = {
      shopSlug: shop.slug,
      code,
      name,
      email: address,
      percent: number(req.body.percent, 'Commission percent', 0, 80),
      status: 'active',
      createdAt: today(),
    };
    await database.collection('affiliates').insertOne(item);
    await audit(database, shop.slug, user.id, 'affiliate.created', code);
    res.status(201).json(serialize(item));
  }),
);
app.patch(
  '/shops/:slug/affiliates/:itemId',
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req, 'manage');
    const status = req.body.status === 'active' ? 'active' : 'paused';
    const item = await database
      .collection('affiliates')
      .findOneAndUpdate(
        { _id: recordId(req.params.itemId), shopSlug: shop.slug },
        { $set: { status } },
        { returnDocument: 'after' },
      );
    assert(item, 404, 'Affiliate not found');
    await audit(database, shop.slug, user.id, `affiliate.${status}`, item.code);
    res.json(serialize(item));
  }),
);
app.get(
  '/shops/:slug/products/:productId/reviews',
  route(async (req, res) => {
    const database = await db();
    await findShop(database, req.params.slug, true);
    const productId = recordId(req.params.productId);
    const rows = await database
      .collection('reviews')
      .find(
        { shopSlug: req.params.slug, productId, status: 'published' },
        { projection: { name: 1, rating: 1, text: 1, createdAt: 1 } },
      )
      .sort({ createdAt: -1 })
      .limit(60)
      .toArray();
    res.json(rows.map(serialize));
  }),
);
app.post(
  '/shops/:slug/products/:productId/reviews',
  route(async (req, res) => {
    const database = await db(),
      productId = recordId(req.params.productId),
      user = actor(req);
    const order = await database.collection('orders').findOne({
      _id: recordId(req.body.orderId),
      shopSlug: req.params.slug,
      'items.productId': productId,
      status: 'delivered',
    });
    assert(
      order &&
        ((user?.id && user.id === order.customerId) ||
          safeEqual(req.body.token, orderAccessToken(order))),
      403,
      'A delivered order is required to review this product',
    );
    const review = {
      shopSlug: order.shopSlug,
      productId,
      orderId: order._id,
      name: trim(order.customer.name, 70),
      rating: number(req.body.rating, 'Rating', 1, 5, true),
      text: trim(req.body.text, 1000),
      status: 'pending',
      createdAt: today(),
    };
    assert(review.text.length >= 5, 400, 'Write at least five characters');
    await database.collection('reviews').insertOne(review);
    res.status(201).json({ status: 'pending' });
  }),
);
app.get(
  '/shops/:slug/reviews',
  route(async (req, res) => {
    const { database, shop } = await workspace(req, 'manage');
    res.json(
      (
        await database
          .collection('reviews')
          .find({ shopSlug: shop.slug })
          .sort({ createdAt: -1 })
          .limit(100)
          .toArray()
      ).map(serialize),
    );
  }),
);
app.patch(
  '/shops/:slug/reviews/:itemId',
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req, 'manage');
    const status = req.body.status === 'published' ? 'published' : 'hidden';
    const result = await database
      .collection('reviews')
      .updateOne({ _id: recordId(req.params.itemId), shopSlug: shop.slug }, { $set: { status } });
    assert(result.matchedCount, 404, 'Review not found');
    await audit(database, shop.slug, user.id, `review.${status}`, req.params.itemId);
    res.json({ ok: true });
  }),
);
app.post(
  '/shops/:slug/abandoned',
  route(async (req, res) => {
    const database = await db(),
      shop = await findShop(database, req.params.slug, true);
    const address = email(req.body.email),
      visitor = trim(req.body.visitor, 100);
    assert(
      req.body.consent === true && address && /^[\w-]{12,100}$/.test(visitor),
      400,
      'Email and explicit reminder consent are required',
    );
    const items = checkoutItems(req.body.items);
    const at = today();
    await database.collection('abandoned').updateOne(
      { shopSlug: shop.slug, visitor },
      {
        $set: {
          email: address,
          items,
          dueAt: new Date(at.getTime() + 60 * 60_000),
          expiresAt: new Date(at.getTime() + days(7)),
          updatedAt: at,
        },
      },
      { upsert: true },
    );
    res.status(202).json({ accepted: true });
  }),
);
app.get(
  '/shops/:slug/abandoned/:visitor',
  route(async (req, res) => {
    const database = await db();
    const item = await database.collection('abandoned').findOne({
      shopSlug: req.params.slug,
      visitor: trim(req.params.visitor, 100),
      expiresAt: { $gt: today() },
    });
    assert(
      item && safeEqual(req.query.token, sign(`abandoned:${item._id}:${item.visitor}`)),
      404,
      'Cart link expired',
    );
    const products = await database
      .collection('products')
      .find({
        shopSlug: req.params.slug,
        _id: { $in: item.items.map((line) => line.productId) },
        active: { $ne: false },
        moderation: { $ne: 'hidden' },
      })
      .toArray();
    res.json(
      item.items.flatMap((line) => {
        const product = products.find((entry) => entry._id.equals(line.productId));
        return product ? [{ ...publicProduct(product), variantId: line.variantId, qty: line.qty }] : [];
      }),
    );
  }),
);

// Research is built from dated observations, with explicit source coverage.
const seasons = [
  {
    id: 'eid',
    name: 'Eid season',
    timing: 'Dates move each year',
    action: 'Add your campaign dates and track apparel, gifts, decor and food demand before each Eid.',
  },
  {
    id: 'boishakh',
    name: 'Pohela Boishakh',
    timing: '14 April in Bangladesh',
    action: 'Watch festive clothing, home goods and gifting.',
  },
  {
    id: 'winter',
    name: 'Winter',
    timing: 'November to February',
    action: 'Compare outerwear, skincare and seasonal household products.',
  },
  {
    id: 'wedding',
    name: 'Wedding season',
    timing: 'Commonly November to February',
    action: 'Monitor accessories, festive wear and gift packaging.',
  },
];
function researchInput(row) {
  const product = trim(row.product, 160),
    category = trim(row.category, 80),
    source = trim(row.source, 100);
  assert(product && category && source, 400, 'Enter a product, category and source');
  return {
    product,
    category,
    source,
    sourceUrl: webUrl(row.sourceUrl),
    searchInterest: number(row.searchInterest, 'Search interest', 0, 100),
    adVolume: number(row.adVolume, 'Ad count', 0, 10_000_000, true),
    competitors: number(row.competitors, 'Competitors', 0, 10_000_000, true),
    averagePrice: number(row.averagePrice, 'Market price', 0, 10_000_000),
    unitCost:
      row.unitCost === '' || row.unitCost == null
        ? null
        : number(row.unitCost, 'Unit cost', 0, 10_000_000),
    currency: currency(row.currency),
    capturedAt: dateValue(row.capturedAt, today()),
  };
}
function researchView(item, ownProducts, prior) {
  const demand = Math.round(
    item.searchInterest * 0.7 + Math.min(100, Math.log10(item.adVolume + 1) * 33) * 0.3,
  );
  const saturation = Math.min(100, Math.round(Math.log10(item.competitors + 1) * 38));
  const margin =
    item.unitCost !== null && item.averagePrice > 0
      ? ((item.averagePrice - item.unitCost) / item.averagePrice) * 100
      : null;
  const previousMargin =
    prior?.unitCost != null && prior.averagePrice > 0
      ? ((prior.averagePrice - prior.unitCost) / prior.averagePrice) * 100
      : null;
  const own = ownProducts.find((entry) => lower(entry.name) === lower(item.product));
  return {
    ...serialize(item),
    score: Math.max(0, Math.round(demand * 0.85 + (100 - saturation) * 0.15)),
    saturation,
    margin,
    oversaturated:
      saturation >= 65 &&
      (demand < 55 ||
        (margin !== null && margin < 20) ||
        (margin !== null && previousMargin !== null && margin < previousMargin - 5)),
    sellerPrice: own?.price ?? null,
    previousPrice: prior?.averagePrice ?? null,
  };
}
app.get(
  '/shops/:slug/research',
  route(async (req, res) => {
    const { database, shop } = await workspace(req, 'manage');
    const rows = await database
      .collection('research')
      .find({
        shopSlug: shop.slug,
        ...(req.query.category ? { category: trim(req.query.category, 80) } : {}),
      })
      .sort({ capturedAt: -1 })
      .limit(1200)
      .toArray();
    const products = await database
      .collection('products')
      .find({ shopSlug: shop.slug }, { projection: { name: 1, price: 1 } })
      .limit(10_000)
      .toArray();
    const grouped = new Map();
    for (const item of rows) {
      const key = `${lower(item.category)}:${lower(item.product)}:${item.currency}`;
      const group = grouped.get(key) || [];
      if (group.length < 2) group.push(item);
      grouped.set(key, group);
    }
    const suppliers = await database
      .collection('suppliers')
      .find({ shopSlug: shop.slug })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    const calendar = await database
      .collection('seasons')
      .find({ shopSlug: shop.slug })
      .sort({ startsAt: 1 })
      .limit(60)
      .toArray();
    res.json({
      feed: [...grouped.values()]
        .map(([item, prior]) =>
          researchView(item, item.currency === currency(shop.currency) ? products : [], prior),
        )
        .sort((a, b) => b.score - a.score)
        .slice(0, 100),
      sources: [...new Set(rows.map((item) => item.source))],
      observations: rows.length,
      suppliers: suppliers.map(serialize),
      calendar: [...seasons, ...calendar.map(serialize)],
    });
  }),
);
async function importResearch(database, shopSlug, rows) {
  assert(
    Array.isArray(rows) && rows.length && rows.length <= 500,
    400,
    'Provide 1–500 market observations',
  );
  const items = rows.map((row, index) => {
    try {
      return researchInput(row);
    } catch (error) {
      throw new HttpError(400, `Observation ${index + 1}: ${error.message}`);
    }
  });
  const result = await database.collection('research').bulkWrite(
    items.map((item) => {
      const key = hash(
        [
          shopSlug,
          lower(item.product),
          lower(item.category),
          lower(item.source),
          item.currency,
          item.capturedAt.toISOString().slice(0, 10),
        ].join('|'),
      );
      return {
        updateOne: { filter: { _id: key }, update: { $set: { ...item, shopSlug } }, upsert: true },
      };
    }),
  );
  return result.upsertedCount + result.matchedCount;
}
app.post(
  '/shops/:slug/research',
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req, 'manage');
    const imported = await importResearch(
      database,
      shop.slug,
      Array.isArray(req.body) ? req.body : [req.body],
    );
    await audit(database, shop.slug, user.id, 'research.imported', String(imported));
    res.status(201).json({ imported });
  }),
);
app.post(
  '/shops/:slug/research/import',
  upload.single('file'),
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req, 'manage');
    assert(req.file && /\.csv$/i.test(req.file.originalname), 400, 'Choose a CSV file');
    let rows;
    try {
      rows = parseCsv(req.file.buffer, { columns: true, skip_empty_lines: true, bom: true });
    } catch {
      throw new HttpError(400, 'The observation CSV could not be parsed');
    }
    const imported = await importResearch(database, shop.slug, rows);
    await audit(database, shop.slug, user.id, 'research.imported', String(imported));
    res.status(201).json({ imported });
  }),
);
app.post(
  '/shops/:slug/research/sync',
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req, 'manage');
    const cfg = (await providerConfig(database, shop.slug)).market;
    assert(providerReady('market', cfg), 503, 'Connect an authorized market data feed first');
    const url = await externalUrl(cfg.endpoint);
    const data = await publicRequest(
      url,
      { headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {} },
      'Market feed',
    );
    const imported = await importResearch(
      database,
      shop.slug,
      Array.isArray(data) ? data : data.observations,
    );
    await audit(database, shop.slug, user.id, 'research.synced', String(imported));
    res.json({ imported });
  }),
);
app.post(
  '/shops/:slug/suppliers',
  route(async (req, res) => {
    const { database, shop } = await workspace(req, 'manage');
    const item = {
      shopSlug: shop.slug,
      name: trim(req.body.name, 100),
      location: trim(req.body.location, 120),
      category: trim(req.body.category, 80),
      url: webUrl(req.body.url),
      notes: trim(req.body.notes, 500),
      createdAt: today(),
    };
    assert(item.name && (item.location || item.url), 400, 'Enter a supplier name and location or URL');
    await database.collection('suppliers').insertOne(item);
    res.status(201).json(serialize(item));
  }),
);
app.delete(
  '/shops/:slug/suppliers/:itemId',
  route(async (req, res) => {
    const { database, shop } = await workspace(req, 'manage');
    await database
      .collection('suppliers')
      .deleteOne({ _id: recordId(req.params.itemId), shopSlug: shop.slug });
    res.json({ ok: true });
  }),
);
app.post(
  '/shops/:slug/seasons',
  route(async (req, res) => {
    const { database, shop } = await workspace(req, 'manage');
    const item = {
      shopSlug: shop.slug,
      name: trim(req.body.name, 100),
      startsAt: dateValue(req.body.startsAt),
      endsAt: dateValue(req.body.endsAt),
      action: trim(req.body.action, 600),
      createdAt: today(),
    };
    assert(
      item.name && item.startsAt && item.endsAt && item.endsAt >= item.startsAt,
      400,
      'Enter a name and valid start and end dates',
    );
    await database.collection('seasons').insertOne(item);
    res.status(201).json(serialize(item));
  }),
);
app.delete(
  '/shops/:slug/seasons/:itemId',
  route(async (req, res) => {
    const { database, shop } = await workspace(req, 'manage');
    await database
      .collection('seasons')
      .deleteOne({ _id: recordId(req.params.itemId), shopSlug: shop.slug });
    res.json({ ok: true });
  }),
);

const webhookEvents = ['order.created', 'order.updated', 'product.updated'];
async function enqueueWebhooks(database, shopSlug, event, data, session) {
  const hooks = await database
    .collection('webhooks')
    .find({ shopSlug, active: true, events: event }, { session })
    .toArray();
  for (const hook of hooks)
    await queue(
      database,
      shopSlug,
      'webhook',
      { hookId: String(hook._id), event, data },
      today(),
      session,
    );
}
app.get(
  '/shops/:slug/webhooks',
  route(async (req, res) => {
    const { database, shop } = await workspace(req, 'owner');
    res.json(
      (
        await database
          .collection('webhooks')
          .find({ shopSlug: shop.slug }, { projection: { secret: 0 } })
          .toArray()
      ).map(serialize),
    );
  }),
);
app.post(
  '/shops/:slug/webhooks',
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req, 'owner');
    const url = (await externalUrl(req.body.url)).href;
    const events = [
      ...new Set(
        Array.isArray(req.body.events)
          ? req.body.events.filter((event) => webhookEvents.includes(event))
          : [],
      ),
    ];
    assert(events.length, 400, 'Select a webhook event');
    assert(
      (await database.collection('webhooks').countDocuments({ shopSlug: shop.slug })) < 10,
      409,
      'Use up to ten webhooks',
    );
    const secret = randomBytes(32).toString('hex');
    const item = {
      shopSlug: shop.slug,
      url,
      events,
      active: true,
      secret: encrypt(secret),
      createdAt: today(),
    };
    await database.collection('webhooks').insertOne(item);
    await audit(database, shop.slug, user.id, 'webhook.created', String(item._id));
    res.status(201).json({ ...serialize(item), secret });
  }),
);
app.delete(
  '/shops/:slug/webhooks/:itemId',
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req, 'owner');
    await database
      .collection('webhooks')
      .deleteOne({ _id: recordId(req.params.itemId), shopSlug: shop.slug });
    await audit(database, shop.slug, user.id, 'webhook.removed', req.params.itemId);
    res.json({ ok: true });
  }),
);
function xml(value) {
  return String(value ?? '').replace(
    /[<>&"']/g,
    (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character],
  );
}
app.get(
  '/shops/:slug/feed.xml',
  route(async (req, res) => {
    const database = await db(),
      shop = await findShop(database, req.params.slug, true);
    const products = await database
      .collection('products')
      .find({
        shopSlug: shop.slug,
        active: { $ne: false },
        moderation: { $ne: 'hidden' },
        imageUrl: { $ne: '' },
      })
      .limit(10_000)
      .toArray();
    const base = `${clientUrl}/shops/${shop.slug}`;
    const rows = products.flatMap((item) =>
      (item.variants?.length ? item.variants : [null]).map(
        (variant) =>
          `<item><g:id>${xml(variant ? `${item._id}-${variant.id}` : item._id)}</g:id><g:title>${xml(`${item.name}${variant ? ` · ${variant.name}` : ''}`)}</g:title><g:description>${xml(item.description || item.name)}</g:description><g:link>${xml(`${base}/products/${item._id}${variant ? `?variant=${variant.id}` : ''}`)}</g:link><g:image_link>${xml(variant?.imageUrl || item.imageUrl)}</g:image_link><g:availability>${(variant?.stock ?? item.stock) > 0 ? 'in_stock' : item.backorder ? 'backorder' : 'out_of_stock'}</g:availability><g:price>${Number(variant?.price ?? item.price).toFixed(2)} ${currency(shop.currency)}</g:price><g:condition>new</g:condition>${variant ? `<g:item_group_id>${item._id}</g:item_group_id>` : ''}</item>`,
      ),
    );
    await storefrontResponse(
      database,
      shop,
      req,
      res,
      `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>${xml(shop.name)}</title><link>${xml(base)}</link><description>${xml(shop.description || shop.name)}</description>${rows.join('')}</channel></rss>`,
      'application/xml',
    );
  }),
);
app.get(
  '/shops/:slug/notifications',
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req);
    const rows = await database
      .collection('notifications')
      .find({ shopSlug: shop.slug })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    res.json(
      rows.map((item) => ({
        ...serialize(item),
        read: (item.readBy || []).includes(user.id),
        readBy: undefined,
      })),
    );
  }),
);
app.patch(
  '/shops/:slug/notifications/:itemId',
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req);
    await database
      .collection('notifications')
      .updateOne(
        { _id: recordId(req.params.itemId), shopSlug: shop.slug },
        { $addToSet: { readBy: user.id } },
      );
    res.json({ ok: true });
  }),
);
app.post(
  '/shops/:slug/campaigns/email',
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req, 'manage');
    const cfg = await providerConfig(database, shop.slug);
    assert(
      providerReady('email', cfg.email) || (env.RESEND_API_KEY && env.EMAIL_FROM),
      503,
      'Connect email delivery first',
    );
    const subject = trim(req.body.subject, 150),
      body = trim(req.body.body, 1800);
    assert(subject && body, 400, 'Enter a subject and message');
    const contacts = await database
      .collection('marketingContacts')
      .find({ shopSlug: shop.slug, emailConsent: true })
      .limit(200)
      .toArray();
    assert(contacts.length, 409, 'There are no subscribed customers yet');
    for (const contact of contacts) {
      const token = sign(`unsubscribe:${contact._id}`);
      await queue(database, shop.slug, 'email', {
        to: contact.email,
        subject,
        text: `${body}\n\nUnsubscribe: ${serverUrl}/shops/${shop.slug}/unsubscribe?id=${contact._id}&token=${token}`,
        marketingId: String(contact._id),
      });
    }
    await audit(database, shop.slug, user.id, 'email_campaign.queued', String(contacts.length));
    res.status(202).json({ queued: contacts.length });
  }),
);
app.post(
  '/shops/:slug/subscribe',
  route(async (req, res) => {
    const database = await db(),
      shop = await findShop(database, req.params.slug, true);
    const address = email(req.body.email);
    assert(
      address && req.body.consent === true,
      400,
      'Enter an email address and agree to receive updates',
    );
    const cfg = await providerConfig(database, shop.slug);
    const id = hash(`${shop.slug}:${address}`);
    const previous = await database.collection('marketingContacts').findOne({ _id: id });
    if (previous?.emailConsent || previous?.confirmationSentAt > new Date(Date.now() - 10 * 60_000))
      return res.status(202).json({ ok: true });
    assert(
      providerReady('email', cfg.email) || (env.RESEND_API_KEY && env.EMAIL_FROM),
      503,
      'This shop has not configured email subscriptions',
    );
    const code = randomBytes(24).toString('hex');
    await database.collection('marketingContacts').updateOne(
      { _id: id },
      {
        $set: {
          email: address,
          shopSlug: shop.slug,
          emailConsent: false,
          confirmationHash: hash(code),
          confirmationSentAt: today(),
        },
      },
      { upsert: true },
    );
    await queue(database, shop.slug, 'email', {
      to: address,
      subject: `Confirm updates from ${shop.name}`,
      text: `Confirm your subscription: ${serverUrl}/shops/${shop.slug}/subscribe/confirm?id=${id}&code=${code}`,
    });
    res.status(202).json({ ok: true });
  }),
);
app.get(
  '/shops/:slug/subscribe/confirm',
  route(async (req, res) => {
    const database = await db();
    const result = await database.collection('marketingContacts').updateOne(
      {
        _id: trim(req.query.id, 64),
        shopSlug: req.params.slug,
        confirmationHash: hash(req.query.code),
        confirmationSentAt: { $gt: new Date(Date.now() - days(2)) },
      },
      { $set: { emailConsent: true, optedInAt: today() }, $unset: { confirmationHash: '' } },
    );
    assert(result.matchedCount, 404, 'Confirmation link expired');
    res.type('text/plain').send('Subscription confirmed. You can close this page.');
  }),
);
app.get(
  '/shops/:slug/unsubscribe',
  route(async (req, res) => {
    const id = trim(req.query.id, 64);
    assert(
      env.SHOPOS_PROXY_SECRET && safeEqual(req.query.token, sign(`unsubscribe:${id}`)),
      404,
      'Link not found',
    );
    await (await db())
      .collection('marketingContacts')
      .updateOne({ _id: id, shopSlug: req.params.slug }, { $set: { emailConsent: false } });
    res.type('text/plain').send('You have unsubscribed.');
  }),
);

app.get(
  '/shops/:slug/tickets',
  route(async (req, res) => {
    const { database, shop } = await workspace(req);
    res.json(
      (
        await database
          .collection('tickets')
          .find({ shopSlug: shop.slug })
          .sort({ updatedAt: -1 })
          .limit(100)
          .toArray()
      ).map(serialize),
    );
  }),
);
app.post(
  '/shops/:slug/tickets',
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req);
    const title = trim(req.body.title, 120),
      body = trim(req.body.body, 2200);
    assert(title && body, 400, 'Add a subject and a message');
    const ticket = {
      shopSlug: shop.slug,
      title,
      status: 'open',
      messages: [{ from: user.name || user.email, body, at: today(), type: 'seller' }],
      createdAt: today(),
      updatedAt: today(),
    };
    await database.collection('tickets').insertOne(ticket);
    res.status(201).json(serialize(ticket));
  }),
);
async function replyTicket(database, filter, user, input, admin = false) {
  const body = trim(input.body, 2200);
  assert(
    body || (admin && ['open', 'closed'].includes(input.status)),
    400,
    'Write a message or change ticket status',
  );
  const update = {
    $set: {
      updatedAt: today(),
      ...(admin && ['open', 'closed'].includes(input.status) ? { status: input.status } : {}),
    },
  };
  if (body)
    update.$push = {
      messages: {
        $each: [
          {
            from: admin ? 'ShopOS support' : user.name || user.email,
            body,
            at: today(),
            type: admin ? 'support' : 'seller',
          },
        ],
        $slice: -100,
      },
    };
  const item = await database
    .collection('tickets')
    .findOneAndUpdate(filter, update, { returnDocument: 'after' });
  assert(item, 404, 'Support ticket not found');
  return serialize(item);
}
app.post(
  '/shops/:slug/tickets/:itemId/reply',
  route(async (req, res) => {
    const { database, shop, user } = await workspace(req);
    res.json(
      await replyTicket(
        database,
        { _id: recordId(req.params.itemId), shopSlug: shop.slug, status: 'open' },
        user,
        req.body,
      ),
    );
  }),
);
app.get(
  '/admin/overview',
  route(async (req, res) => {
    requireAdmin(req);
    const database = await db();
    const [counts, gmv, openTickets, churn] = await Promise.all([
      database
        .collection('shops')
        .aggregate([{ $group: { _id: { $ifNull: ['$status', 'active'] }, count: { $sum: 1 } } }])
        .toArray(),
      database
        .collection('orders')
        .aggregate([
          { $match: { paymentStatus: 'paid', status: { $nin: ['cancelled', 'returned'] } } },
          {
            $group: {
              _id: { $ifNull: ['$currency', 'BDT'] },
              total: { $sum: '$total' },
              orders: { $sum: 1 },
            },
          },
        ])
        .toArray(),
      database.collection('tickets').countDocuments({ status: 'open' }),
      database.collection('shops').countDocuments({
        'billing.status': 'canceled',
        'billing.eventAt': { $gte: new Date(Date.now() - days(30)) },
      }),
    ]);
    res.json({
      shops: Object.fromEntries(counts.map((row) => [row._id, row.count])),
      gmv: gmv.map((row) => ({ currency: row._id, total: row.total, orders: row.orders })),
      openTickets,
      churn30: churn,
    });
  }),
);
app.get(
  '/admin/shops',
  route(async (req, res) => {
    requireAdmin(req);
    const { skip, limit } = pageLimit(req);
    const shops = await (await db())
      .collection('shops')
      .find({})
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();
    res.json(
      shops.map((item) => ({
        id: String(item._id),
        slug: item.slug,
        name: item.name,
        ownerEmail: item.ownerEmail,
        plan: effectivePlan(item),
        status: item.status || 'active',
        createdAt: item.createdAt,
      })),
    );
  }),
);
app.patch(
  '/admin/shops/:slug',
  route(async (req, res) => {
    const user = requireAdmin(req),
      database = await db();
    const set = {};
    if (req.body.status !== undefined) {
      assert(['active', 'pending', 'suspended'].includes(req.body.status), 400, 'Choose a shop status');
      set.status = req.body.status;
    }
    if (req.body.plan !== undefined) {
      assert(Object.hasOwn(defaultPlans, req.body.plan), 400, 'Choose a platform plan');
      const shop = await findShop(database, req.params.slug);
      assert(
        !shop.billing?.subscriptionId ||
          !['active', 'trialing', 'past_due'].includes(shop.billing.status),
        409,
        'Change this plan in Stripe Billing',
      );
      set.billing = {
        plan: req.body.plan,
        status: req.body.plan === 'free' ? 'free' : 'active',
        cadence: 'manual',
        endsAt: dateValue(req.body.endsAt),
      };
      if (req.body.plan === 'free') set.trialEndsAt = null;
    }
    if (req.body.commissionPercent !== undefined)
      set.commissionPercent = number(req.body.commissionPercent, 'Commission', 0, 100);
    const item = await database
      .collection('shops')
      .findOneAndUpdate({ slug: req.params.slug }, { $set: set }, { returnDocument: 'after' });
    assert(item, 404, 'Shop not found');
    await audit(database, item.slug, user.id, 'admin.shop_updated', item.slug);
    res.json({ status: item.status || 'active', plan: effectivePlan(item) });
  }),
);
app.get(
  '/admin/plans',
  route(async (req, res) => {
    requireAdmin(req);
    res.json(await plans(await db()));
  }),
);
app.put(
  '/admin/plans/:plan',
  route(async (req, res) => {
    const user = requireAdmin(req),
      database = await db();
    assert(Object.hasOwn(defaultPlans, req.params.plan), 404, 'Plan not found');
    const set = {};
    for (const [key, max] of Object.entries({
      products: 100_000,
      pages: 500,
      seats: 100,
      bandwidth: 10_000_000_000_000,
      monthly: 1_000_000,
      yearly: 5_000_000,
      lifetime: 10_000_000,
      commissionPercent: 100,
    })) {
      if (req.body[key] !== undefined)
        set[`values.${req.params.plan}.${key}`] = number(
          req.body[key],
          key,
          ['products', 'pages', 'seats'].includes(key) ? 1 : 0,
          max,
          ['products', 'pages', 'seats', 'bandwidth'].includes(key),
        );
    }
    await database.collection('platform').updateOne({ _id: 'plans' }, { $set: set }, { upsert: true });
    await audit(database, 'platform', user.id, 'admin.plan_updated', req.params.plan);
    res.json(await plans(database));
  }),
);
app.get(
  '/admin/products',
  route(async (req, res) => {
    requireAdmin(req);
    const { skip, limit } = pageLimit(req);
    res.json(
      (
        await (
          await db()
        )
          .collection('products')
          .find({ ...(req.query.shop ? { shopSlug: trim(req.query.shop, 55) } : {}) })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray()
      ).map(serialize),
    );
  }),
);
app.patch(
  '/admin/products/:itemId',
  route(async (req, res) => {
    const user = requireAdmin(req),
      database = await db();
    const item = await database.collection('products').findOneAndUpdate(
      { _id: recordId(req.params.itemId) },
      {
        $set: {
          moderation: req.body.status === 'visible' ? 'visible' : 'hidden',
          moderationNote: trim(req.body.note, 400),
          updatedAt: today(),
        },
      },
      { returnDocument: 'after' },
    );
    assert(item, 404, 'Product not found');
    await audit(database, item.shopSlug, user.id, 'admin.product_reviewed', String(item._id));
    res.json(serialize(item));
  }),
);
app.get(
  '/admin/tickets',
  route(async (req, res) => {
    requireAdmin(req);
    res.json(
      (
        await (await db()).collection('tickets').find({}).sort({ updatedAt: -1 }).limit(100).toArray()
      ).map(serialize),
    );
  }),
);
app.post(
  '/admin/tickets/:itemId/reply',
  route(async (req, res) => {
    const user = requireAdmin(req),
      database = await db();
    const item = await replyTicket(database, { _id: recordId(req.params.itemId) }, user, req.body, true);
    await audit(database, item.shopSlug, user.id, 'admin.ticket_updated', item.id);
    res.json(item);
  }),
);
app.get(
  '/admin/audit',
  route(async (req, res) => {
    requireAdmin(req);
    res.json(
      (await (await db()).collection('audit').find({}).sort({ createdAt: -1 }).limit(150).toArray()).map(
        serialize,
      ),
    );
  }),
);

async function sendEmail(config, payload, jobId) {
  const apiKey = config?.apiKey || env.RESEND_API_KEY,
    from = config?.from || env.EMAIL_FROM;
  if (!apiKey || !from) return false;
  await requestJson(
    'https://api.resend.com/emails',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': String(jobId),
      },
      body: JSON.stringify({ from, to: [payload.to], subject: payload.subject, text: payload.text }),
    },
    'Email delivery',
  );
  return true;
}
async function sendMessage(config, to, body, channel = 'sms') {
  if (!providerReady('sms', config) || !/^AC[a-f0-9]{32}$/i.test(config.accountSid)) return false;
  const from = channel === 'whatsapp' ? config.whatsappFrom : config.from;
  if (!from) return false;
  const phone = to.replace(/[ ()-]/g, '').replace(/^0(?=1\d{9}$)/, '+880');
  if (!/^\+\d{8,15}$/.test(phone)) return false;
  await requestJson(
    `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        From: channel === 'whatsapp' ? `whatsapp:${from.replace(/^whatsapp:/, '')}` : from,
        To: channel === 'whatsapp' ? `whatsapp:${phone}` : phone,
        Body: body,
      }),
    },
    'Order message',
  );
  return true;
}
async function runJob(database, job) {
  const cfg = await providerConfig(database, job.shopSlug),
    payload = job.payload;
  if (job.type.startsWith('tracking.')) {
    const provider = job.type.split('.')[1];
    if (providerReady(provider, cfg[provider])) await sendTracking(provider, cfg[provider], payload);
  } else if (job.type === 'email') {
    if (
      payload.marketingId &&
      !(await database
        .collection('marketingContacts')
        .findOne({ _id: payload.marketingId, emailConsent: true }))
    )
      return;
    await sendEmail(cfg.email, payload, job._id);
  } else if (job.type === 'webhook') {
    const hook = await database
      .collection('webhooks')
      .findOne({ _id: toId(payload.hookId), shopSlug: job.shopSlug, active: true });
    if (!hook) return;
    const target = await externalUrl(hook.url);
    const body = JSON.stringify({
      id: String(job._id),
      event: payload.event,
      shop: job.shopSlug,
      data: payload.data,
      createdAt: job.createdAt,
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    await publicRequest(
      target,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ShopOS-Event': payload.event,
          'X-ShopOS-Timestamp': timestamp,
          'X-ShopOS-Signature': sign(`${timestamp}.${body}`, decrypt(hook.secret)),
        },
        body,
      },
      'Webhook delivery',
    );
  } else if (job.type === 'courier.create') {
    const shop = await findShop(database, job.shopSlug);
    if (providerReady(payload.provider, cfg[payload.provider]))
      await dispatchCourier(shop, toId(payload.orderId), payload.provider);
  } else if (job.type === 'order.message') {
    const order = await database
      .collection('orders')
      .findOne({ _id: toId(payload.orderId), shopSlug: job.shopSlug });
    if (!order) return;
    const link = checkoutReturn(order, order.paymentMethod);
    const text = `Your order ${String(order._id).slice(-7)} is ${payload.status}. Track it at ${link}`;
    if (order.customer.email)
      await sendEmail(
        cfg.email,
        { to: order.customer.email, subject: `Order ${payload.status}`, text },
        job._id,
      );
    if (order.customer.notifySms) await sendMessage(cfg.sms, order.customer.phone, text);
    if (order.customer.notifyWhatsapp)
      await sendMessage(cfg.sms, order.customer.phone, text, 'whatsapp');
  }
}
async function runMaintenance(database) {
  const reminders = await database
    .collection('abandoned')
    .find({ dueAt: { $lte: today() }, sentAt: { $exists: false } })
    .limit(15)
    .toArray();
  for (const item of reminders) {
    const cfg = await providerConfig(database, item.shopSlug);
    if (!providerReady('email', cfg.email) && !(env.RESEND_API_KEY && env.EMAIL_FROM)) continue;
    await transaction(async (database, session) => {
      const updated = await database
        .collection('abandoned')
        .updateOne(
          { _id: item._id, sentAt: { $exists: false } },
          { $set: { sentAt: today() } },
          { session },
        );
      if (!updated.modifiedCount) return;
      const link = `${clientUrl}/shops/${item.shopSlug}/cart?recover=${item.visitor}&token=${sign(`abandoned:${item._id}:${item.visitor}`)}`;
      await queue(
        database,
        item.shopSlug,
        'email',
        {
          to: item.email,
          subject: 'Your saved shopping cart',
          text: `Resume your cart: ${link}\nYou requested one reminder for this cart.`,
        },
        today(),
        session,
      );
    });
  }
  const stale = await database
    .collection('orders')
    .find({
      paymentStatus: 'pending',
      status: 'pending',
      $or: [
        { checkoutExpiresAt: { $lt: new Date(Date.now() - days(1)) } },
        { checkoutUrl: { $exists: false }, createdAt: { $lt: new Date(Date.now() - days(1)) } },
      ],
    })
    .limit(15)
    .toArray();
  for (const order of stale) {
    try {
      await setOrderStatus({ slug: order.shopSlug }, order._id, 'cancelled', 'worker');
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 409))
        console.warn('Unpaid order cleanup failed', error.code || error.name);
    }
  }
  const deliveries = await database
    .collection('orders')
    .find({
      status: 'shipped',
      'courier.consignmentId': { $exists: true },
      'courier.syncedAt': { $lt: new Date(Date.now() - 2 * 60 * 60_000) },
    })
    .limit(8)
    .toArray();
  for (const order of deliveries) {
    try {
      await syncCourier({ slug: order.shopSlug }, order);
    } catch {
      await database
        .collection('orders')
        .updateOne({ _id: order._id }, { $set: { 'courier.syncedAt': today() } });
    }
  }
}
async function work(limit = 10) {
  const database = await db();
  let processed = 0;
  const until = Date.now() + 22_000;
  while (processed < limit && Date.now() < until) {
    const claim = randomUUID();
    const job = await database.collection('jobs').findOneAndUpdate(
      {
        dueAt: { $lte: today() },
        $or: [{ state: 'pending' }, { state: 'running', leaseUntil: { $lt: today() } }],
      },
      {
        $set: { state: 'running', lease: claim, leaseUntil: new Date(Date.now() + 120_000) },
        $inc: { attempts: 1 },
      },
      { sort: { dueAt: 1 }, returnDocument: 'after' },
    );
    if (!job) break;
    try {
      await runJob(database, job);
      await database.collection('jobs').deleteOne({ _id: job._id, lease: claim });
    } catch (error) {
      const fail = job.attempts >= 5;
      await database.collection('jobs').updateOne(
        { _id: job._id, lease: claim },
        {
          $set: {
            state: fail ? 'failed' : 'pending',
            dueAt: new Date(Date.now() + 60_000 * 2 ** job.attempts),
            lastError: trim(error.message, 200),
          },
          $unset: { lease: '', leaseUntil: '' },
        },
      );
      if (fail)
        await notice(
          database,
          job.shopSlug,
          'integration',
          'Integration needs attention',
          `${job.type}: ${trim(error.message, 150)}`,
        );
    }
    processed++;
  }
  await runMaintenance(database);
  return processed;
}
app.all(
  '/jobs/run',
  route(async (req, res) => {
    assert(
      env.CRON_SECRET && safeEqual(req.get('authorization'), `Bearer ${env.CRON_SECRET}`),
      401,
      'Job runner access required',
    );
    res.json({ processed: await work(20) });
  }),
);
app.get(
  '/shops/:slug/jobs',
  route(async (req, res) => {
    const { database, shop } = await workspace(req, 'owner');
    const jobs = await database
      .collection('jobs')
      .find({ shopSlug: shop.slug }, { projection: { payload: 0, lease: 0 } })
      .sort({ createdAt: -1 })
      .limit(30)
      .toArray();
    res.json(jobs.map(serialize));
  }),
);
app.post(
  '/shops/:slug/jobs/:itemId/retry',
  route(async (req, res) => {
    const { database, shop } = await workspace(req, 'owner');
    const result = await database
      .collection('jobs')
      .updateOne(
        { _id: recordId(req.params.itemId), shopSlug: shop.slug, state: 'failed' },
        { $set: { state: 'pending', attempts: 0, dueAt: today() } },
      );
    assert(result.modifiedCount, 404, 'Failed job not found');
    res.json({ ok: true });
  }),
);

app.use((_req, res) => res.status(404).json({ error: 'API route not found' }));
app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  if (error instanceof HttpError)
    return res.status(error.status).json({ error: error.message, code: error.code });
  if (error.code === 11000)
    return res
      .status(409)
      .json({ error: 'That name, SKU or code is already in use', code: 'DUPLICATE' });
  if (error instanceof multer.MulterError || error.status === 413)
    return res.status(413).json({ error: 'The upload exceeds the allowed size or file count' });
  if (error.type === 'entity.parse.failed')
    return res.status(400).json({ error: 'Invalid request data' });
  console.error(
    'ShopOS request failed',
    error.name,
    error.code || '',
    env.NODE_ENV === 'development' ? error.stack : '',
  );
  res
    .status(500)
    .json({ error: 'The request could not be completed. Check server configuration and try again.' });
});

if (!env.VERCEL && env.NODE_ENV !== 'test') {
  app.listen(Number(env.PORT || 8000), () => console.log(`ShopOS API listening on ${env.PORT || 8000}`));
  if (env.RUN_LOCAL_JOBS === 'true') {
    let active = false;
    setInterval(async () => {
      if (active) return;
      active = true;
      try {
        await work(12);
      } catch (error) {
        console.warn('Job runner failed', error.name, error.code || '');
      } finally {
        active = false;
      }
    }, 30_000).unref();
  }
}
export default app;
