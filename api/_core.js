/* Server-side recipe generation.
 *
 * This runs on the server, never in the browser, so the Gemini key stays secret.
 * The client sends only the chosen ingredients — it cannot send a raw prompt —
 * which stops this endpoint being used as a free general-purpose AI proxy.
 *
 * Shared by the Vercel function (api/recipes.js) and the local dev middleware
 * (vite.config.js) so both behave identically.
 */

const MODEL = "gemini-2.5-flash-lite";

/* What each wheel category means. Keyed by the exact item label used in the UI
   so the prompt can send ONLY the selected definition — sending all 27 bloated
   the prompt and encouraged the model to drift to a protein we didn't ask for. */
const DEFS = {
  protein: {
    "Poultry": "chicken, duck, or turkey",
    "Red Meat": "beef or lamb",
    "Pork": "pork chops, tenderloin, or belly",
    "Ground Meat & Sausage": "ground beef, ground pork, ground chicken, chorizo, or Italian sausage",
    "Fish": "salmon, cod, tuna, or halibut",
    "Shrimp & Shellfish": "shrimp, scallops, mussels, or crab",
    "Plant-based": "tofu or tempeh",
  },
  veggie: {
    "Leafy Greens": "spinach, kale, bok choy, or Swiss chard",
    "Broccoli & Cabbage": "broccoli, cauliflower, cabbage, or Brussels sprouts",
    "Peppers, Eggplant & Asparagus": "bell peppers, eggplant, or asparagus",
    "Squash": "zucchini, butternut squash, or acorn squash",
    "Beans & Corn": "green beans, snap peas, edamame, or corn",
    "Root Veg": "carrots, sweet potato, parsnips, or beets",
  },
  carb: {
    "Rice": "white, brown, jasmine, or basmati rice",
    "Noodles": "pasta, soba, udon, ramen, or rice noodles",
    "Bread": "crusty bread, flatbread, tortillas, or pita",
    "Potatoes": "roasted, mashed, or wedged potatoes, or sweet potato",
    "Grains": "quinoa, farro, couscous, or barley",
    "Legumes": "lentils, chickpeas, or black beans",
  },
  /* "cooking" rather than "flavors" on purpose — "South Asian flavors" was read
     as licence to season a shepherd's pie with curry powder and call it done. */
  style: {
    "Asian": "Japanese, Chinese, Korean, Thai, Vietnamese, Filipino, Indian, Sri Lankan, or Pakistani cooking",
    "Italian & Mediterranean": "Italian, Greek, or Spanish cooking",
    "French & Continental": "French, Belgian, or Swiss cooking",
    "Latin American": "Mexican, Peruvian, or Brazilian cooking",
    "Middle Eastern": "Lebanese, Turkish, Persian, or Moroccan cooking",
    "American": "BBQ, Southern, or American comfort cooking",
  },
};

/* What each difficulty actually means. Sent alongside the label so the model
   isn't left guessing what "Easy" implies. Mirrors the DIFF descriptions the
   user sees in the app — keep the two in step if either changes. */
const DIFF_DETAIL = {
  Easy: "~20 min, one pan",
  Medium: "30–45 min, some prep",
  Hard: "1 hr+, multi-step",
};

/* Gemini enforces this shape server-side, so every recipe is guaranteed to have
   all five fields — no half-built recipes can reach the UI. */
const RECIPE_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      name: { type: "STRING" },
      description: { type: "STRING" },
      tags: { type: "ARRAY", items: { type: "STRING" } },
      steps: { type: "ARRAY", items: { type: "STRING" } },
      shoppingList: { type: "ARRAY", items: { type: "STRING" } },
    },
    required: ["name", "description", "tags", "steps", "shoppingList"],
  },
};

// Users can type their own value in the re-spin modal, so it may not be in DEFS.
// In that case send the value alone rather than an empty "()".
function describe(kind, value) {
  const def = DEFS[kind]?.[value];
  return def ? value + " (" + def + ")" : value;
}

export function buildPrompt({ results, toppings, diffLabel, servings, pantry, feedback }) {
  const staples = pantry?.staples || [];
  const useSoon = pantry?.useSoon || [];
  const loved = feedback?.loved || [];
  const disliked = feedback?.disliked || [];

  // Staples are assumed on hand, so they're excluded from the shopping list.
  // Use-soon items are a nudge, never a requirement — a forced fit makes bad food.
  const pantryLines = [];
  if (staples.length) {
    pantryLines.push(
      "",
      // "where they suit the cuisine" stops soy sauce turning up in a Greek dish.
      "Already in the kitchen (use freely where they suit the cuisine, and do NOT put these on the shopping list): " + staples.join(", ") + ".",
      "Only list a staple on the shopping list if the recipe needs an unusually large amount of it."
    );
  }
  if (useSoon.length) {
    pantryLines.push(
      "",
      "Leftovers to use up — these may be finished dishes rather than raw ingredients (work them in where they genuinely fit, and skip any that would hurt the dish): " + useSoon.join(", ") + "."
    );
  }

  /* Past verdicts steer style, not exact dishes — repeating a loved recipe
     verbatim would defeat the point of spinning. */
  const tasteLines = [];
  if (loved.length) {
    tasteLines.push(
      "",
      "They previously loved: " + loved.join("; ") + ".",
      "Use this loosely as input for future recipe suggestions."
    );
  }
  if (disliked.length) {
    tasteLines.push("", "They disliked: " + disliked.join("; ") + ". Avoid that style.");
  }

  return [
    "You are an exceptionally creative home cooking assistant. Generate exactly 2 dinner recipes within the given parameters.",
    "",
    "Protein: " + describe("protein", results.protein),
    "Veggie: " + describe("veggie", results.veggie),
    "Carb: " + describe("carb", results.carb),
    "Cuisine: " + describe("style", results.style),
    // Omitted entirely when empty — a line reading "none" is noise, not information.
    ...(toppings ? ["Extra ingredients for tonight: " + toppings] : []),
    "Difficulty: " + diffLabel + (DIFF_DETAIL[diffLabel] ? " (" + DIFF_DETAIL[diffLabel] + ")" : ""),
    "Servings: " + servings + " people — scale quantities accordingly.",
    ...pantryLines,
    ...tasteLines,
    "",
    "Both recipes must use " + results.protein + " as the main protein.",
    /* Without this the cuisine reads as a suggestion and the model drifts —
       a shepherd's pie was once returned for South Asian. Naming the dish
       itself (not just its seasoning) is what stops "X with curry spices". */
    "Both recipes must be dishes you would genuinely find in " + results.style + " cooking — not a dish from another cuisine with " + results.style + " seasoning added.",
    "",
    "Descriptions: plain and direct, like a friend texting. One sentence on what it is, one on the flavors.",
    "",
    "For each recipe provide:",
    "- name",
    "- description: 2 plain sentences",
    "- tags: exactly 3 short strings (e.g. '30 min', 'one pan', 'spicy')",
    "- steps: plain-English cooking steps",
    "- shoppingList: strings with quantities for " + servings + " people — everything you need to BUY (produce, protein, pantry items not already on hand, spices, oils, condiments)",
  ].join("\n");
}

// Reject anything that isn't a sane, small string so we can't be used to smuggle
// a giant arbitrary prompt through to the model.
function clean(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export function normalizeInput(body) {
  const b = body && typeof body === "object" ? body : {};
  const r = b.results && typeof b.results === "object" ? b.results : {};
  const results = {
    protein: clean(r.protein, 60),
    veggie: clean(r.veggie, 60),
    carb: clean(r.carb, 60),
    style: clean(r.style, 60),
  };
  if (!results.protein || !results.veggie || !results.carb || !results.style) {
    throw new Error("Missing ingredients");
  }
  const servings = Math.min(Math.max(parseInt(b.servings, 10) || 2, 1), 8);
  return {
    results,
    toppings: clean(b.toppings, 400),
    diffLabel: ["Easy", "Medium", "Hard"].includes(b.diffLabel) ? b.diffLabel : "Medium",
    servings,
    pantry: {
      staples: cleanList(b.pantry?.staples),
      useSoon: cleanList(b.pantry?.useSoon),
    },
    feedback: {
      loved: cleanList(b.feedback?.loved, 160, 8),
      disliked: cleanList(b.feedback?.disliked, 160, 8),
    },
  };
}

// Caps both item length and list length so a large pantry can't balloon the prompt.
function cleanList(value, maxLen = 80, maxItems = 60) {
  if (!Array.isArray(value)) return [];
  return value.map(v => clean(v, maxLen)).filter(Boolean).slice(0, maxItems);
}

async function requestOnce(apiKey, prompt, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent?key=" + apiKey,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: RECIPE_SCHEMA,
            temperature: 1.1, // a little extra spread so repeat spins vary
          },
        }),
        signal: controller.signal,
      }
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || "API error");
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!text) throw new Error("Empty response from Gemini");
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("Invalid recipe array");
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

/* Retries once — covers a flaky network or an occasional bad generation.
 * onPrompt receives the exact text sent to the model; the dev server uses it to
 * print the prompt so the wording can be reviewed while tuning. */
export async function generateRecipes(apiKey, input, { retries = 1, timeoutMs = 20000, onPrompt } = {}) {
  if (!apiKey) throw new Error("Server is missing GEMINI_KEY");
  const prompt = buildPrompt(input);
  if (onPrompt) onPrompt(prompt);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await requestOnce(apiKey, prompt, timeoutMs);
    } catch (e) {
      lastErr = e.name === "AbortError" ? new Error("Upstream request timed out") : e;
    }
  }
  throw lastErr;
}
