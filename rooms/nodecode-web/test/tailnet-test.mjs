// tailnet-test.mjs -- page/tailnet.js on its own, in node, under the least
// document it needs: the pill's colour for each place the page is served from,
// what its panel offers there, and what each of its buttons asks the cell.
// Run by tailnet-test.lisp as `node tailnet-test.mjs <page/tailnet.js>`; its
// last line is "TAILNET <n> passed, <m> failed".
import { pathToFileURL } from "node:url";

// --- the least document: elements with classes, data, children and text -------
class Node {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.className = "";
    this.hidden = false;
    this.ownText = "";
    this.parent = null;
  }
  set textContent(text) { this.children = []; this.ownText = String(text); }
  get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(""); }
  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === "string" ? Object.assign(new Node("#text"), { ownText: node }) : node;
      child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  hasAttribute(name) { return name in this.attributes; }
  toggleAttribute(name, on) { if (on) this.attributes[name] = ""; else delete this.attributes[name]; }
  closest(selector) {
    const key = selector.match(/^\[data-(\w+)\]$/)?.[1];
    for (let node = this; node; node = node.parent) if (key && key in node.dataset) return node;
    return null;
  }
  all() { return [this, ...this.children.flatMap((child) => child.all())]; }
}
globalThis.document = {
  documentElement: {},
  createElement: (tag) => new Node(tag),
  createTextNode: (text) => Object.assign(new Node("#text"), { ownText: text }),
};
Object.defineProperty(globalThis, "navigator", { value: { languages: ["en-US"], language: "en-US" }, configurable: true });
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.location = { hostname: "127.0.0.1" };

const { makeTailnet } = await import(pathToFileURL(process.argv[2]).href);
let passed = 0;
let failed = 0;
const check = (ok, what) => {
  if (ok) passed++;
  else { failed++; console.log(`FAIL ${what}`); }
};

const here = { name: "desk", host: "desk.example.ts.net", address: "https://desk.example.ts.net:8434/web/", current: true };
const there = { name: "far", host: "far.example.ts.net", address: "https://far.example.ts.net:8434/web/", current: false };
const asleep = { name: "cold", host: "cold.example.ts.net", address: null, current: false };
const ACCESS = {
  available: true, running: true, address: here.address, code: "ABCD-EFGH", code_minutes: 10,
  devices: [{ index: 0, name: "phone", login: "me@example" }, { index: 1, name: "laptop", login: "" }],
  refusal: null, advice: null, this_device: null,
};

/** A pill on HOST over a cell answering ACCESS and MACHINES (404 when ACCESS is null). */
async function pill(host, access, machines = [here, there, asleep]) {
  location.hostname = host;
  const asked = [];
  const toasts = [];
  const api = async (method, path, body) => {
    asked.push({ method, path, body });
    if (!access) throw Object.assign(new Error("404"), { status: 404 });
    if (path === "/api/remote/peers") return { machines };
    if (method === "POST") {
      if (body.action === "stop") return { ...access, running: false, code: null };
      if (body.action === "refuse") throw Object.assign(new Error("no"), { status: 409 });
      return access;
    }
    return access;
  };
  const mark = new Node("button");
  const panel = new Node("div");
  const tailnet = makeTailnet({ api, toast: (text, how) => toasts.push({ text, ...how }), mark, panel });
  await tailnet.read();
  return { tailnet, mark, panel, asked, toasts };
}
const open = async (p) => { p.panel.toggleAttribute("data-open", true); p.tailnet.open(); await new Promise((r) => setTimeout(r, 0)); };
const words = (p) => p.panel.textContent;
const acts = (p) => p.panel.all().filter((node) => "tn" in node.dataset).map((node) => node.dataset.tn);
const links = (p) => p.panel.all().filter((node) => node.tagName === "A").map((node) => [node.textContent, node.href]);
const press = async (p, tn, index) => {
  const target = p.panel.all().find((node) => node.dataset.tn === tn && (index === undefined || node.dataset.index === String(index)));
  p.tailnet.click({ target, stopPropagation() { p.stopped = true; } });
  await new Promise((r) => setTimeout(r, 0));
  return target;
};

// --- the pill's colour says where the page comes from ---------------------------
{
  const p = await pill("127.0.0.1", ACCESS);
  check(!p.mark.hidden && p.mark.dataset.where === "local", "on loopback, serving: the pill is shown and green");
  const off = await pill("localhost", { ...ACCESS, running: false, code: null });
  check(!off.mark.hidden && off.mark.dataset.where === "", "on loopback, not serving: the pill is unlit");
  const far = await pill("desk.example.ts.net", ACCESS);
  check(far.mark.dataset.where === "remote", "over the tailnet: the pill is blue");
  const none = await pill("127.0.0.1", null);
  check(none.mark.hidden, "no tailnet access cell (404): no pill");
  check(p.asked.some((a) => a.path === "/api/remote") && p.asked.some((a) => a.path === "/api/remote/peers"), "a read asks both access and the machines");
}

// --- the panel on loopback: turn on and off, address, code, machines, devices ----
{
  const p = await pill("127.0.0.1", ACCESS);
  await open(p);
  const text = words(p);
  check(acts(p).includes("stop"), "loopback, serving: Turn off is offered");
  check(text.includes(ACCESS.address) && text.includes("ABCD-EFGH"), "the address and the code are shown");
  check(acts(p).filter((a) => a === "forget").length === 2, "each paired device can be forgotten");
  check(text.includes("desk") && text.includes("far") && text.includes("cold"), "every machine is listed");
  check(JSON.stringify(links(p)) === JSON.stringify([["Switch", there.address]]), "only a reachable other machine offers Switch, to its address");
  const dots = p.panel.all().filter((node) => node.className === "tn-dot");
  check(dots.map((d) => d.dataset.where || "").join(",") === "local,,", "the machine shown is marked green, the others hollow");
  const off = await pill("127.0.0.1", { ...ACCESS, running: false, code: null });
  await open(off);
  check(acts(off).includes("start") && !words(off).includes(ACCESS.address), "loopback, off: Turn on is offered, and no address");
  const alone = await pill("127.0.0.1", ACCESS, [here]);
  await open(alone);
  check(!words(alone).includes("Machines on your tailnet"), "alone on loopback: no list of one");
}

// --- the panel over the tailnet: no switch off, the list is the way back -------
{
  const p = await pill("desk.example.ts.net", { ...ACCESS, this_device: 1 }, [here, there]);
  await open(p);
  check(!acts(p).includes("stop") && !acts(p).includes("start"), "over the tailnet: access cannot be turned off from the page it serves");
  check(words(p).includes("laptop") && words(p).includes("this browser"), "the paired device asking is named as this browser");
  const dots = p.panel.all().filter((node) => node.className === "tn-dot");
  check(dots[0].dataset.where === "remote", "the machine shown is marked blue");
  const alone = await pill("desk.example.ts.net", ACCESS, [here]);
  await open(alone);
  check(words(alone).includes("Machines on your tailnet"), "over the tailnet, even alone: the list is drawn");
}

// --- unavailable: the advice, and nothing to act on ------------------------------
{
  const advice = { text: "Tailscale is not running.", step: "Start it.", label: "Tailscale", url: "https://tailscale.com/download" };
  const p = await pill("127.0.0.1", { ...ACCESS, available: false, running: false, advice });
  await open(p);
  check(words(p).includes("Tailscale is not running.") && words(p).includes("Start it."), "unavailable: the cell's advice is shown");
  check(acts(p).length === 0 && links(p)[0][1] === advice.url, "unavailable: only the advice's link, no acts");
}

// --- what each button asks the cell ----------------------------------------------
{
  const p = await pill("127.0.0.1", ACCESS);
  await open(p);
  await press(p, "forget", 1);
  check(p.stopped, "a click in the panel stays in it");
  check(p.asked.some((a) => a.method === "POST" && a.body.action === "forget" && a.body.index === 1), "Forget sends the device's index");
  await press(p, "code");
  check(p.asked.some((a) => a.method === "POST" && a.body.action === "code"), "New code asks for one");
  await press(p, "stop");
  check(p.mark.dataset.where === "" && acts(p).includes("start"), "Turn off: the pill goes unlit and Turn on is offered");
  const refused = await pill("127.0.0.1", ACCESS);
  await open(refused);
  const target = refused.panel.all().find((node) => node.dataset.tn === "code");
  target.dataset.tn = "refuse";
  await press(refused, "refuse");
  check(refused.toasts.some((x) => x.error) && !refused.panel.all().some((node) => node.dataset.busy), "a refused act says why, and its button is free again");
}

console.log(`TAILNET ${passed} passed, ${failed} failed`);
