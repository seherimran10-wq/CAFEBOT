const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const CLAUDE_MODEL = 'claude-sonnet-5';
const SESSION_COOKIE = 'cafebot_session_id';
const TAX_RATE = Number(process.env.TAX_RATE) || 0.0825;
const DELIVERY_FEE = Number(process.env.DELIVERY_FEE) || 3.0;
// The repo's data/ directory is read-only on Vercel, so writes there fail
// outright — fall back to the OS temp dir there, which is writable.
const ORDERS_PATH = process.env.VERCEL
  ? path.join(os.tmpdir(), 'orders.json')
  : path.join(__dirname, '..', 'data', 'orders.json');
const ORDER_STATUSES = ['NEW', 'PREPARING', 'READY', 'COMPLETED'];
const MAX_TOOL_ITERATIONS = 8;

// In-memory only — lost on restart. Revisit before production.
const orderSessions = new Map();

function createOrderState() {
  return {
    items: [], // { id, quantity, options }
    orderType: null, // 'pickup' | 'delivery'
    customer: { name: null, phone: null, email: null },
    pickupTime: null, // null = not yet specified; 'ASAP' = customer has no preference
    delivery: { address: null, apartmentUnit: null, instructions: null },
    discount: null,
    confirmed: false,
    status: 'building', // 'building' | 'confirmed' | 'submitted' | 'cancelled'
    suggestedItemIds: [], // items already recommended this session — never re-suggest
  };
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((pair) => {
    const index = pair.indexOf('=');
    if (index === -1) return;
    cookies[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim());
  });
  return cookies;
}

function getOrderState(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  let sessionId = cookies[SESSION_COOKIE];
  if (!sessionId || !orderSessions.has(sessionId)) {
    sessionId = crypto.randomUUID();
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/`);
    orderSessions.set(sessionId, createOrderState());
  }
  return orderSessions.get(sessionId);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, '..', 'prompts', 'system-prompt.md'),
  'utf8'
);
const SYSTEM_PROMPT_WITH_MENU = `${SYSTEM_PROMPT}\n\nMANDATORY CHECKOUT STEP — read this first: the moment the customer says they're done ordering or ready to check out, before you say anything else, find out whether this is a pickup or delivery order (ask if it isn't already clear), then collect the required details for that order type with no exceptions, regardless of whether you can process payment.\n\nFor pickup: ask for the customer's name (e.g. "Can I get a name for the order?") and record it with the setPickupDetails tool. Call it first with no arguments to check whether the name (and pickup time) are already known before asking again. Do not tell the customer their order is final, confirmed, or ready until setPickupDetails returns status "confirmed". Pickup time is optional — ask once, and if the customer has no preference, record "ASAP" via setPickupDetails so it's not asked again.\n\nFor delivery: collect the customer's name, phone number, full delivery address, apartment/unit (if applicable), and delivery instructions using the setDeliveryDetails tool — never guess any of these. Call it first with no arguments to check what's already known before asking again. Do not tell the customer their order is final, confirmed, or ready until setDeliveryDetails returns status "confirmed"; if it returns "needs_info", ask only for the fields it lists as missing. Apartment/unit and delivery instructions are optional — ask once each, and if not applicable, record "none" via setDeliveryDetails so they aren't asked again. Once setDeliveryDetails returns "confirmed", as its own separate step, read the full delivery address back to the customer word-for-word (street address plus apartment/unit, if any) and ask them to confirm it's correct or give a correction — do not proceed to checkout until they explicitly confirm it. If they correct it, call setDeliveryDetails again with the correction and repeat the updated address back for confirmation before moving on.\n\nUse the getMenu tool to look up current menu items instead of relying on memory. Use the addItemToCart tool when the customer wants to order something. If it responds with status "needs_options", ask the customer for exactly those options — do not guess a value on their behalf. Use the removeItem tool to remove an item or reduce its quantity; if it responds with status "needs_clarification", ask which variant they mean instead of guessing. Use the viewCart tool whenever the customer asks what's in their order, rather than relying on conversation history. To change an item's chosen options, remove it with removeItem and add it again with addItemToCart; there's no separate edit tool. You cannot process payment yourself — let the customer know they'll pay at the counter for pickup, or on delivery/through their usual method for delivery orders.\n\nWhen addItemToCart succeeds, its result includes a "recommendations" array — real menu items worth suggesting alongside what was just added. If it's non-empty, offer those exact items (and only those) after confirming the addition; if it's empty, don't bring up a recommendation. Never suggest a pairing from your own reasoning about the menu. If the customer asks directly for a recommendation instead, call the getRecommendations tool and use only what it returns, never more. If the customer declines a suggestion, drop it and don't bring it up again.\n\nUse the applyPromotion tool for anything about discounts or promotions. Call it with no promotionId to see which active promotions the current cart qualifies for, and only mention promotions it returns — never one from your own memory. If the customer names a discount or promo code, call applyPromotion with that exact id rather than judging it yourself; report exactly what it says (invalid, inactive, not eligible with its reason, or applied) instead of guessing. Never tell a customer a discount is applied unless applyPromotion returns status "applied".

Never calculate, estimate, or state an order's subtotal, tax, delivery fee, or total yourself — always call the getOrderTotal tool and relay exactly the numbers it returns. Call it fresh after any change to the cart or an applied promotion, and always immediately before the final order read-back and confirmation; never reuse a total from earlier in the conversation. The cartTotal field returned by addItemToCart/removeItem is only a running subtotal for casual mid-order mentions ("added — that's $X so far") — it excludes tax, delivery fee, and discounts, so don't quote it as the final total.

Never tell a customer their order is placed, finalized, or submitted based on your own reading of what they said — that decision is never yours to make. After reading back the full order and total, ask one clear yes/no question (e.g. "Shall I place this order?"), then call finalizeOrder with the customer's next reply passed verbatim in customerReply. If it returns "confirmed", the order is saved — tell the customer and give them the orderId if useful. If it returns "ambiguous", their reply did not count as confirmation, even if it sounded positive — do not treat the order as final; ask again for an explicit yes or no. If it returns "incomplete", resolve whatever it says is missing, then ask for confirmation again before calling it. If the customer changes or corrects anything after you've asked for confirmation, update the order, get a fresh total, and ask for confirmation again from scratch.`;

// The system prompt (plus the tool schema, which the API caches alongside
// it) is identical on every /api/chat call — including the extra calls the
// tool-use loop makes within a single customer turn, and across different
// customers. Marking it cache_control lets Anthropic reuse it instead of
// billing full price on every call.
const SYSTEM_PROMPT_CACHED = [
  { type: 'text', text: SYSTEM_PROMPT_WITH_MENU, cache_control: { type: 'ephemeral' } },
];

// Option categories where the customer must pick a value; the rest (flavors, add-ons) are optional extras.
const OPTIONAL_OPTION_KEYS = ['flavors', 'add-ons'];

const TOOLS = [
  {
    name: 'getMenu',
    description: 'Get the café\'s current menu items that are available for order.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'addItemToCart',
    description:
      'Add a menu item to the customer\'s order. Fails with status "needs_options" if a required option (e.g. size, milk) is missing, listing which ones — ask the customer and call again instead of guessing.',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'The menu item id, from getMenu.' },
        quantity: { type: 'integer', description: 'How many to add. Defaults to 1.' },
        options: {
          type: 'object',
          description: 'Chosen option values, e.g. { "sizes": "medium", "milk": "oat" }.',
        },
      },
      required: ['itemId'],
    },
  },
  {
    name: 'removeItem',
    description:
      'Remove an item from the cart, or reduce its quantity. If multiple variants of the item (different options) are in the cart, fails with status "needs_clarification" listing them — ask which one and call again with matching options instead of guessing.',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'The menu item id to remove.' },
        quantity: {
          type: 'integer',
          description: 'How many to remove. Omit to remove the entire line.',
        },
        options: {
          type: 'object',
          description: 'The option values of the specific cart line, needed only to disambiguate multiple variants.',
        },
      },
      required: ['itemId'],
    },
  },
  {
    name: 'viewCart',
    description:
      'Get a concise, itemized list of what is currently in the customer\'s cart — items, quantities, and chosen options. Does not include totals.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'getRecommendations',
    description:
      'Get up to 2 real menu items that pair well with what\'s currently in the cart (e.g. a pastry for a coffee). Use this when the customer directly asks for a recommendation — addItemToCart already returns fresh recommendations automatically after each add, so there\'s no need to call this right after adding an item. Returns an empty array if the cart is empty or nothing new is left to suggest. Never suggests an item already in the cart or already suggested this session, even if declined.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'setPickupDetails',
    description:
      'REQUIRED before finalizing a pickup order, with no exceptions: set or check the customer name and optional pickup time. Call with no arguments first to see what\'s already known before asking the customer anything. Returns status "needs_name" if the name is still missing, or "confirmed" with the current name and pickup time otherwise. If the customer has no preference for pickup time, call again with pickupTime "ASAP" so it\'s recorded as answered. Do not describe an order as final, confirmed, or checked out until this tool has returned "confirmed".',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Customer name for the pickup order.' },
        pickupTime: { type: 'string', description: 'Requested pickup time (e.g. "5:30 PM"), or "ASAP" if the customer has no preference.' },
      },
    },
  },
  {
    name: 'setDeliveryDetails',
    description:
      'REQUIRED before finalizing a delivery order, with no exceptions: set or check the customer name, phone number, full delivery address, apartment/unit, and delivery instructions. Call with no arguments first to see what\'s already known before asking the customer anything. Never guess any of these values. Returns status "needs_info" listing exactly which required fields (name, phone, address) are still missing, or "confirmed" with all current details otherwise. Apartment/unit and delivery instructions are optional — ask once each; if not applicable or the customer has none, call again with that field set to "none" so it\'s recorded as answered instead of asked again. Do not describe an order as final, confirmed, or checked out until this tool has returned "confirmed".',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Customer name for the delivery order.' },
        phone: { type: 'string', description: 'Customer phone number.' },
        address: { type: 'string', description: 'Full delivery street address.' },
        apartmentUnit: { type: 'string', description: 'Apartment or unit number, or "none" if not applicable.' },
        instructions: { type: 'string', description: 'Delivery instructions (e.g. gate code, "leave at door"), or "none" if the customer has none.' },
      },
    },
  },
  {
    name: 'getOrderTotal',
    description:
      'Get the authoritative, deterministically-calculated order total: subtotal (from real menu prices and quantities), any applied promotion discount, tax, delivery fee, and grand total. Always call this instead of calculating, estimating, or remembering a total yourself. Call it fresh any time you need to quote a total to the customer — after adding or removing an item, after a promotion is applied, and always immediately before the final order read-back and confirmation.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'applyPromotion',
    description:
      'Check or apply a café promotion from data/promotions.json. Call with no promotionId to list which active promotions the current cart qualifies for right now. Call with a promotionId to apply that exact promotion — fails with status "invalid" if the id isn\'t a real promotion, "inactive" if it exists but isn\'t currently running, or "not_eligible" with a reason if the cart doesn\'t meet its rules. Never apply or accept a discount/code this tool doesn\'t confirm.',
    input_schema: {
      type: 'object',
      properties: {
        promotionId: {
          type: 'string',
          description: 'The id of the promotion to apply, from a prior applyPromotion listing or a code the customer names. Omit to list eligible promotions instead.',
        },
      },
    },
  },
  {
    name: 'finalizeOrder',
    description:
      'REQUIRED to save or finalize an order — never tell the customer their order is placed, finalized, or submitted without calling this and getting status "confirmed". Call it only right after reading back the full order summary and total and explicitly asking the customer to confirm. Pass their exact, verbatim reply in customerReply — never paraphrase, summarize, or infer it. Fails with status "incomplete" if required order details are still missing (resolve those first), or "ambiguous" if the reply is not an unambiguous explicit confirmation — e.g. it hedges, asks a question, requests a change, or is unclear in any way. On "ambiguous", do not treat the order as confirmed; ask the customer again for a clear yes or no and call again with their next literal reply. Only "confirmed" means the order was actually saved.',
    input_schema: {
      type: 'object',
      properties: {
        customerReply: {
          type: 'string',
          description: "The customer's exact, verbatim reply to the final confirmation question — not your interpretation of it.",
        },
      },
      required: ['customerReply'],
    },
  },
];

const COMPLEMENTARY_CATEGORIES = {
  coffee: ['pastry', 'food'],
  tea: ['pastry'],
  pastry: ['coffee', 'tea'],
  food: ['coffee', 'tea'],
  other: ['pastry'],
};

function loadMenu() {
  const menu = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'menu.json'), 'utf8'));
  return menu.items;
}

function loadPromotions() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'promotions.json'), 'utf8'));
  return data.promotions;
}

function getMenu() {
  return loadMenu().filter((item) => item.available);
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function computeSubtotal(order) {
  const menu = loadMenu();
  return round2(
    order.items.reduce((sum, line) => {
      const item = menu.find((entry) => entry.id === line.id);
      return sum + (item ? item.price * line.quantity : 0);
    }, 0)
  );
}

function normalizeOptions(options) {
  const sortedEntries = Object.entries(options || {}).sort(([keyA], [keyB]) => keyA.localeCompare(keyB));
  return JSON.stringify(sortedEntries);
}

function sameOptions(a, b) {
  return normalizeOptions(a) === normalizeOptions(b);
}

function addItemToCart(order, input) {
  const { itemId, quantity = 1, options = {} } = input || {};

  const item = getMenu().find((menuItem) => menuItem.id === itemId);
  if (!item) {
    return { status: 'error', message: `"${itemId}" is not a valid, available menu item.` };
  }

  if (!Number.isInteger(quantity) || quantity < 1) {
    return { status: 'error', message: 'quantity must be a positive whole number.' };
  }

  const requiredKeys = Object.keys(item.options || {}).filter(
    (key) => !OPTIONAL_OPTION_KEYS.includes(key) && item.options[key].length > 0
  );

  const missing = requiredKeys.filter((key) => !options[key]);
  if (missing.length > 0) {
    return {
      status: 'needs_options',
      item: item.name,
      missing: missing.map((key) => ({ option: key, choices: item.options[key] })),
    };
  }

  const invalid = Object.keys(options).filter(
    (key) => item.options[key] && !item.options[key].includes(options[key])
  );
  if (invalid.length > 0) {
    return {
      status: 'error',
      message: invalid
        .map((key) => `"${options[key]}" isn't a valid ${key} for ${item.name}. Choices: ${item.options[key].join(', ')}.`)
        .join(' '),
    };
  }

  order.items.push({ id: item.id, quantity, options });

  return {
    status: 'added',
    item: item.name,
    quantity,
    options,
    cartTotal: computeSubtotal(order),
    recommendations: getRecommendations(order),
  };
}

function removeItem(order, input) {
  const { itemId, quantity, options } = input || {};

  if (quantity !== undefined && (!Number.isInteger(quantity) || quantity < 1)) {
    return { status: 'error', message: 'quantity must be a positive whole number.' };
  }

  let matches = order.items.filter((line) => line.id === itemId);
  if (matches.length === 0) {
    return { status: 'error', message: `There's no "${itemId}" in the cart.` };
  }

  if (options !== undefined) {
    matches = matches.filter((line) => sameOptions(line.options, options));
    if (matches.length === 0) {
      return { status: 'error', message: `No cart line for "${itemId}" matches those options.` };
    }
  }

  if (matches.length > 1) {
    return {
      status: 'needs_clarification',
      item: itemId,
      variants: matches.map((line) => ({ options: line.options, quantity: line.quantity })),
    };
  }

  const line = matches[0];
  const menuItem = loadMenu().find((entry) => entry.id === itemId);

  const removeQty = Math.min(quantity !== undefined ? quantity : line.quantity, line.quantity);
  line.quantity -= removeQty;

  if (line.quantity <= 0) {
    order.items.splice(order.items.indexOf(line), 1);
  }

  return {
    status: 'removed',
    item: menuItem ? menuItem.name : itemId,
    quantityRemoved: removeQty,
    remainingQuantity: Math.max(line.quantity, 0),
    cartTotal: computeSubtotal(order),
  };
}

function viewCart(order) {
  const menu = loadMenu();
  return order.items.map((line) => {
    const menuItem = menu.find((entry) => entry.id === line.id);
    return {
      item: menuItem ? menuItem.name : line.id,
      quantity: line.quantity,
      options: line.options,
    };
  });
}

function getRecommendations(order) {
  if (order.items.length === 0) return [];

  const menu = getMenu();
  const cartItemIds = new Set(order.items.map((line) => line.id));
  const cartCategories = new Set(
    order.items.map((line) => menu.find((item) => item.id === line.id)?.category).filter(Boolean)
  );

  const wantedCategories = new Set();
  cartCategories.forEach((category) => {
    (COMPLEMENTARY_CATEGORIES[category] || []).forEach((c) => wantedCategories.add(c));
  });

  const candidates = menu.filter(
    (item) =>
      wantedCategories.has(item.category) &&
      !cartItemIds.has(item.id) &&
      !order.suggestedItemIds.includes(item.id)
  );

  const picks = candidates.slice(0, 2);
  order.suggestedItemIds.push(...picks.map((item) => item.id));

  return picks.map((item) => ({
    id: item.id,
    name: item.name,
    price: item.price,
    description: item.description,
  }));
}

function cartHasCategory(order, menu, category) {
  return order.items.some((line) => menu.find((item) => item.id === line.id)?.category === category);
}

function setPickupDetails(order, input) {
  const { name, pickupTime } = input || {};

  order.orderType = 'pickup';

  if (typeof name === 'string' && name.trim()) {
    order.customer.name = name.trim();
  }

  if (typeof pickupTime === 'string' && pickupTime.trim()) {
    order.pickupTime = pickupTime.trim();
  }

  if (!order.customer.name) {
    return { status: 'needs_name', pickupTime: order.pickupTime };
  }

  return { status: 'confirmed', name: order.customer.name, pickupTime: order.pickupTime };
}

function setDeliveryDetails(order, input) {
  const { name, phone, address, apartmentUnit, instructions } = input || {};

  order.orderType = 'delivery';

  if (typeof name === 'string' && name.trim()) {
    order.customer.name = name.trim();
  }
  if (typeof phone === 'string' && phone.trim()) {
    order.customer.phone = phone.trim();
  }
  if (typeof address === 'string' && address.trim()) {
    order.delivery.address = address.trim();
  }
  if (typeof apartmentUnit === 'string' && apartmentUnit.trim()) {
    order.delivery.apartmentUnit = apartmentUnit.trim();
  }
  if (typeof instructions === 'string' && instructions.trim()) {
    order.delivery.instructions = instructions.trim();
  }

  const missing = [];
  if (!order.customer.name) missing.push('name');
  if (!order.customer.phone) missing.push('phone');
  if (!order.delivery.address) missing.push('address');

  const current = {
    name: order.customer.name,
    phone: order.customer.phone,
    address: order.delivery.address,
    apartmentUnit: order.delivery.apartmentUnit,
    instructions: order.delivery.instructions,
  };

  if (missing.length > 0) {
    return { status: 'needs_info', missing, current };
  }

  return { status: 'confirmed', ...current };
}

function checkPromotionEligibility(order, promotion) {
  const menu = loadMenu();
  const rules = promotion.eligibility || {};

  if (rules.categories && !rules.categories.some((category) => cartHasCategory(order, menu, category))) {
    return { eligible: false, reason: `Requires an item from: ${rules.categories.join(', ')}.` };
  }

  if (rules.requiresItemFromCategory && !cartHasCategory(order, menu, rules.requiresItemFromCategory)) {
    return { eligible: false, reason: `Requires an item from the ${rules.requiresItemFromCategory} category in the same order.` };
  }

  if (typeof rules.minOrderTotal === 'number' && computeSubtotal(order) < rules.minOrderTotal) {
    return { eligible: false, reason: `Order total must be at least $${rules.minOrderTotal.toFixed(2)}.` };
  }

  if (rules.days) {
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    if (!rules.days.includes(today)) {
      return { eligible: false, reason: `Only valid on: ${rules.days.join(', ')}.` };
    }
  }

  if (rules.timeWindow) {
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const toMinutes = (value) => {
      const [hours, minutes] = value.split(':').map(Number);
      return hours * 60 + minutes;
    };
    if (currentMinutes < toMinutes(rules.timeWindow.start) || currentMinutes >= toMinutes(rules.timeWindow.end)) {
      return { eligible: false, reason: `Only valid between ${rules.timeWindow.start} and ${rules.timeWindow.end}.` };
    }
  }

  if (rules.requiresLoyaltyPunches) {
    return { eligible: false, reason: 'Loyalty punch tracking is not available yet.' };
  }

  return { eligible: true };
}

function formatTimeOfDay(hhmm) {
  const [hours, minutes] = hhmm.split(':').map(Number);
  const period = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return minutes === 0 ? `${hour12} ${period}` : `${hour12}:${String(minutes).padStart(2, '0')} ${period}`;
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

function describePromotionSchedule(promotion) {
  const rules = promotion.eligibility || {};
  const parts = [];

  if (rules.days) {
    const isWeekdays = rules.days.length === WEEKDAYS.length && WEEKDAYS.every((day) => rules.days.includes(day));
    parts.push(isWeekdays ? 'Weekdays' : rules.days.join(', '));
  }
  if (rules.timeWindow) {
    parts.push(`${formatTimeOfDay(rules.timeWindow.start)}–${formatTimeOfDay(rules.timeWindow.end)}`);
  }

  return parts.length ? parts.join(', ') : null;
}

// Whether a promotion is currently live for a browsing customer — based only
// on its schedule (day/time), not on what's in any particular cart.
function getPromotionStatus(promotion) {
  const schedule = describePromotionSchedule(promotion);

  if (!promotion.active) {
    return { status: 'inactive', schedule };
  }

  const rules = promotion.eligibility || {};
  let withinSchedule = true;

  if (rules.days) {
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    if (!rules.days.includes(today)) withinSchedule = false;
  }
  if (rules.timeWindow) {
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const toMinutes = (value) => {
      const [hours, minutes] = value.split(':').map(Number);
      return hours * 60 + minutes;
    };
    if (currentMinutes < toMinutes(rules.timeWindow.start) || currentMinutes >= toMinutes(rules.timeWindow.end)) {
      withinSchedule = false;
    }
  }

  return { status: withinSchedule ? 'active' : 'upcoming', schedule };
}

function computePromotionDiscount(order, promotion) {
  const menu = loadMenu();
  const categories = (promotion.eligibility || {}).categories || [];

  const eligibleSubtotal = order.items.reduce((sum, line) => {
    const item = menu.find((entry) => entry.id === line.id);
    if (!item || !categories.includes(item.category)) return sum;
    return sum + item.price * line.quantity;
  }, 0);

  if (promotion.discountType === 'percentage') {
    return Math.round(eligibleSubtotal * (promotion.discountValue / 100) * 100) / 100;
  }
  if (promotion.discountType === 'fixed') {
    return Math.min(promotion.discountValue, eligibleSubtotal);
  }
  return 0;
}

function applyPromotion(order, input) {
  const { promotionId } = input || {};
  const promotions = loadPromotions();

  if (!promotionId) {
    const eligible = promotions
      .filter((promotion) => promotion.active)
      .filter((promotion) => checkPromotionEligibility(order, promotion).eligible)
      .map((promotion) => ({
        id: promotion.id,
        name: promotion.name,
        rule: promotion.rule,
        estimatedSavings: computePromotionDiscount(order, promotion),
      }));

    return { status: eligible.length > 0 ? 'eligible' : 'none', promotions: eligible };
  }

  const promotion = promotions.find((entry) => entry.id === promotionId);
  if (!promotion) {
    return { status: 'invalid', message: `"${promotionId}" isn't a recognized promotion.` };
  }
  if (!promotion.active) {
    return { status: 'inactive', message: `"${promotion.name}" isn't currently active.` };
  }

  const eligibility = checkPromotionEligibility(order, promotion);
  if (!eligibility.eligible) {
    return { status: 'not_eligible', promotion: promotion.name, reason: eligibility.reason };
  }

  const discountAmount = computePromotionDiscount(order, promotion);
  order.discount = {
    id: promotion.id,
    name: promotion.name,
    discountType: promotion.discountType,
    discountValue: promotion.discountValue,
    amount: discountAmount,
  };

  return {
    status: 'applied',
    promotion: promotion.name,
    discountAmount,
  };
}

function getOrderTotal(order) {
  const subtotal = computeSubtotal(order);
  const discountAmount = order.discount ? round2(Math.min(order.discount.amount, subtotal)) : 0;
  const discountedSubtotal = round2(Math.max(subtotal - discountAmount, 0));
  const tax = round2(discountedSubtotal * TAX_RATE);
  const deliveryFee = order.orderType === 'delivery' ? DELIVERY_FEE : 0;
  const total = round2(discountedSubtotal + tax + deliveryFee);

  return {
    subtotal,
    discount: order.discount ? { name: order.discount.name, amount: discountAmount } : null,
    tax,
    deliveryFee,
    total,
  };
}

// Orders are persisted to a local JSON file. This is for development/demo
// purposes only — Vercel's serverless functions run on ephemeral, read-only
// filesystems and do not guarantee that writes here survive between
// invocations or deploys. Replace with a real database before production.
function loadOrders() {
  try {
    return JSON.parse(fs.readFileSync(ORDERS_PATH, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function saveOrders(orders) {
  fs.writeFileSync(ORDERS_PATH, JSON.stringify(orders, null, 2));
}

// Deterministic, backend-enforced check — an order is never finalized on the
// model's own reading of ambiguous phrasing, only on a reply matching one of
// these explicit, unhedged confirmation patterns and none of the reject ones.
const AMBIGUOUS_REPLY_PATTERNS = [
  /\bno\b/, /\bnot\b/, /\bdon'?t\b/, /\bwait\b/, /\bactually\b/, /\bchange\b/,
  /\bhold on\b/, /\bnever ?mind\b/, /\bcancel\b/, /\bstop\b/, /\bmaybe\b/,
  /\bi think\b/, /\bprobably\b/, /\bnot sure\b/, /\bunsure\b/, /\bi guess\b/,
  /\bhmm+\b/, /\blater\b/, /\?/,
];
const EXPLICIT_CONFIRM_PATTERNS = [
  /\byes\b/, /\byep\b/, /\byeah\b/, /\byup\b/, /\bconfirm(ed)?\b/,
  /\bcorrect\b/, /\blooks good\b/, /\bsounds good\b/, /\bgo ahead\b/,
  /\bplace the order\b/, /\bfinalize\b/, /\blet'?s do it\b/, /\bdo it\b/,
  /\bsubmit\b/, /\bperfect\b/, /\bthat works\b/, /\baffirmative\b/,
  /\bthat'?s right\b/, /\ball good\b/, /\bsure\b/, /\bokay\b/, /\bok\b/,
  /\balright\b/, /\bgo for it\b/,
];

function classifyConfirmationReply(rawReply) {
  const text = String(rawReply || '').toLowerCase().trim();
  if (!text) return false;
  if (AMBIGUOUS_REPLY_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return EXPLICIT_CONFIRM_PATTERNS.some((pattern) => pattern.test(text));
}

function finalizeOrder(order, input) {
  if (order.status === 'submitted') {
    return { status: 'already_finalized', orderId: order.orderId };
  }

  if (order.items.length === 0) {
    return { status: 'incomplete', reason: 'The cart is empty.' };
  }
  if (order.orderType !== 'pickup' && order.orderType !== 'delivery') {
    return { status: 'incomplete', reason: 'Order type (pickup or delivery) has not been set.' };
  }
  if (order.orderType === 'pickup' && !order.customer.name) {
    return { status: 'incomplete', reason: 'Pickup details are not confirmed yet — call setPickupDetails.' };
  }
  if (order.orderType === 'delivery' && (!order.customer.name || !order.customer.phone || !order.delivery.address)) {
    return { status: 'incomplete', reason: 'Delivery details are not confirmed yet — call setDeliveryDetails.' };
  }

  const { customerReply } = input || {};
  if (!classifyConfirmationReply(customerReply)) {
    return {
      status: 'ambiguous',
      message: 'That reply is not an unambiguous confirmation. Ask the customer for a clear yes or no before finalizing.',
    };
  }

  const total = getOrderTotal(order);
  const savedOrder = {
    id: crypto.randomUUID(),
    status: 'NEW',
    items: order.items,
    orderType: order.orderType,
    customer: order.customer,
    pickupTime: order.pickupTime,
    delivery: order.delivery,
    ...total,
    confirmedAt: new Date().toISOString(),
  };

  const existingOrders = loadOrders();
  existingOrders.push(savedOrder);
  saveOrders(existingOrders);

  order.confirmed = true;
  order.status = 'submitted';
  order.orderId = savedOrder.id;

  return { status: 'confirmed', orderId: savedOrder.id, total: total.total };
}

function runTool(order, name, input) {
  if (name === 'getMenu') return getMenu();
  if (name === 'addItemToCart') return addItemToCart(order, input);
  if (name === 'removeItem') return removeItem(order, input);
  if (name === 'viewCart') return viewCart(order);
  if (name === 'getRecommendations') return getRecommendations(order);
  if (name === 'setPickupDetails') return setPickupDetails(order, input);
  if (name === 'setDeliveryDetails') return setDeliveryDetails(order, input);
  if (name === 'getOrderTotal') return getOrderTotal(order);
  if (name === 'applyPromotion') return applyPromotion(order, input);
  if (name === 'finalizeOrder') return finalizeOrder(order, input);
  throw new Error(`Unknown tool: ${name}`);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.post('/api/chat', async (req, res) => {
  const { message, conversationHistory } = req.body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  const history = Array.isArray(conversationHistory) ? conversationHistory : [];
  const messages = [...history, { role: 'user', content: message }];
  const order = getOrderState(req, res);

  try {
    let response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT_CACHED,
      tools: TOOLS,
      messages,
    });

    let toolIterations = 0;
    while (response.stop_reason === 'tool_use' && toolIterations < MAX_TOOL_ITERATIONS) {
      toolIterations += 1;
      messages.push({ role: 'assistant', content: response.content });

      const toolResults = response.content
        .filter((block) => block.type === 'tool_use')
        .map((block) => {
          try {
            return {
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(runTool(order, block.name, block.input)),
            };
          } catch (error) {
            return {
              type: 'tool_result',
              tool_use_id: block.id,
              content: error.message,
              is_error: true,
            };
          }
        });

      messages.push({ role: 'user', content: toolResults });

      response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT_CACHED,
        tools: TOOLS,
        messages,
      });
    }

    const reply =
      response.stop_reason === 'tool_use'
        ? "Sorry, that's taking longer than expected to work out. Could you try rephrasing, or asking again in a moment?"
        : response.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('');

    res.json({
      reply,
      // Only the plain user/assistant text turns go back to the client —
      // `messages` also has the intermediate tool_use/tool_result blocks,
      // and truncating that raw array client-side (see HISTORY_LIMIT in
      // app.js) can cut a tool_result off from its matching tool_use, which
      // the API then rejects outright. The order/cart state already lives
      // server-side per session, so the model doesn't need this replayed.
      conversationHistory: [...history, { role: 'user', content: message }, { role: 'assistant', content: reply }],
    });
  } catch (error) {
    console.error('Claude API error:', error.status || error.name, error.message);
    res.json({
      reply: "Sorry, I'm having trouble connecting right now. Please try again in a moment.",
      conversationHistory: history,
    });
  }
});

app.get('/api/promotions', (req, res) => {
  const promotions = loadPromotions().map((promotion) => {
    const { status, schedule } = getPromotionStatus(promotion);
    return {
      id: promotion.id,
      name: promotion.name,
      rule: promotion.rule,
      status,
      schedule,
    };
  });
  res.json(promotions);
});

app.get('/api/staff/orders', (req, res) => {
  res.json(loadOrders());
});

app.patch('/api/staff/orders/:id/status', (req, res) => {
  const { status } = req.body || {};
  const orders = loadOrders();
  const order = orders.find((entry) => entry.id === req.params.id);

  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  const currentIndex = ORDER_STATUSES.indexOf(order.status);
  const nextIndex = ORDER_STATUSES.indexOf(status);
  if (nextIndex === -1 || nextIndex !== currentIndex + 1) {
    return res.status(400).json({
      error: `Cannot move from "${order.status}" to "${status}". Next valid status is "${ORDER_STATUSES[currentIndex + 1] || 'none'}".`,
    });
  }

  order.status = status;
  saveOrders(orders);
  res.json(order);
});

app.listen(PORT, () => {
  console.log(`Cafe Agent server running at http://localhost:${PORT}`);
});
