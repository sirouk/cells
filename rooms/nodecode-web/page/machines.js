// machines.js -- the other organisms this one can switch to, and this one
// reached from the rest of the tailnet.
//
// The list is the cell's (GET /api/web/machines): the organism serving this tab,
// the other homes on this machine, and the instances the operator's tailnet
// answers for. A gateway answers at 127.0.0.1 only -- it refuses any other Host,
// which is how it keeps a rebound name from reaching it -- so a peer is not
// reachable over its tailnet address at all. Choosing one asks the cell to open a
// loopback forward over the operator's own ssh (POST, action connect) and the tab
// then moves to that loopback link, which is a page of its own origin with its
// own token: a navigation, not a frame.
//
// The last group is the other direction (bridge.lisp, GET /api/web/bridge): this
// organism served at its node's own https name, for a phone or a laptop that has
// no ssh and no loopback port. Turning it on hands out a pairing code; a device
// that types it is paired, and can be forgotten on its own. The address is text
// to read and copy, never a link this page follows: it is this page, elsewhere.
import { el } from "./observe.js";
import { t } from "./i18n.js";

export function makeMachines({ api }) {
  /** A row: one line, a dot for whether it is on, a name, and a word about it. */
  function row({ name, meta, link, host, current, on }) {
    const button = el("button", "machine");
    button.type = "button";
    if (current) button.dataset.current = "1";
    const dot = el("span", "dot");
    dot.dataset.state = on ? "on" : "off";
    button.append(dot, el("span", "name", name), el("span", "meta", meta || ""));
    if (link) button.dataset.link = link;
    if (host) { button.dataset.host = host; button.dataset.name = name; }
    return button;
  }

  function group(label) {
    return el("div", "machine-group", label);
  }

  /** A word that does something: a smaller line than a machine's own row. */
  function link(label, act, index) {
    const button = el("button", "machine-link", label);
    button.type = "button";
    button.dataset.act = act;
    if (index !== undefined) button.dataset.index = String(index);
    return button;
  }

  function draw(data) {
    const parts = [group(t("Machines"))];
    const self = data?.self;
    parts.push(row({
      name: self?.name || t("this machine"),
      meta: t("this tab"),
      current: true,
      on: true,
    }));

    const others = (data?.local || []).filter((each) => !each.current);
    const running = others.filter((each) => each.running && each.link);
    if (running.length) {
      parts.push(group(t("On this machine")));
      for (const each of running) {
        parts.push(row({ name: each.label, meta: t("port {port}", { port: each.port }), link: each.link, on: true }));
      }
    }

    const peers = data?.peers || [];
    const online = peers.filter((each) => each.online);
    if (!data?.tailnet) {
      parts.push(el("p", "machine-why", t("No tailnet answers on this machine.")));
    } else if (!online.length) {
      parts.push(el("p", "machine-why", t("Nothing of yours is on the tailnet right now.")));
    } else {
      parts.push(group(t("Your tailnet")));
      for (const each of online) {
        const tunnel = each.tunnel && each.tunnel.up ? each.tunnel : null;
        parts.push(row({
          name: each.name,
          meta: tunnel ? t("connected · port {port}", { port: tunnel.port }) : each.os || t("on the tailnet"),
          host: each.host,
          on: true,
        }));
      }
      const offline = peers.length - online.length;
      if (offline > 0) parts.push(el("p", "machine-why", t("{n} offline", { n: offline })));
    }
    return parts;
  }

  /** This organism at its node's own https name, and the devices paired to it. */
  function remote(state, busy) {
    const parts = [group(t("Remote access"))];
    if (!state) return parts;
    if (!state.available) {
      parts.push(el("p", "machine-why", t("No tailnet names this machine, so there is nothing to serve it over.")));
      return parts;
    }
    const toggle = row({
      name: t("Remote access"),
      meta: busy ? t("working…") : state.running ? t("on") : t("off"),
      on: state.running,
    });
    toggle.dataset.act = state.running ? "stop" : "start";
    if (busy) toggle.dataset.busy = "1";
    parts.push(toggle);
    if (!state.running) return parts;

    // The address is for reading and copying, so it is text, not a link.
    parts.push(el("p", "machine-address", state.address || ""));
    // A code is spent by the device that pairs with it, and none stands
    // until one is asked for: the panel always offers the asking.
    const code = el("div", "machine-code");
    if (state.code) {
      code.append(el("span", "code", state.code),
                  el("span", "meta", t("expires in {n} minutes", { n: state.code_minutes })));
    }
    code.append(link(t("new code"), "code"));
    parts.push(code);
    for (const device of state.devices || []) {
      const each = el("div", "machine-device");
      each.append(el("span", "name", device.name), link(t("forget"), "forget", device.index));
      parts.push(each);
    }
    if (state.refusal) parts.push(el("p", "machine-why", state.refusal));
    return parts;
  }

  /** Framed, the page cannot become another origin: the frame is moved for it. */
  const framed = window.parent !== window;
  function go(url) {
    if (framed) {
      // The view that framed this page holds the clipboard and the frame: it
      // lifts the target's frame refusal by proxying it, so it is asked to move.
      try {
        window.parent.postMessage({ nodecode: "frame", id: 0, kind: "switch", payload: { url } }, "*");
        return;
      } catch (error) {}
    }
    window.location.assign(url);
  }

  /** Choose a machine: a link is followed, a peer is reached first. */
  async function open(button) {
    if (button.dataset.busy === "1") return;
    if (button.dataset.link) {
      // The same tab, on the other organism's own origin.
      go(button.dataset.link);
      return;
    }
    const host = button.dataset.host;
    if (!host) return;
    const meta = button.querySelector(".meta");
    const was = meta?.textContent || "";
    button.dataset.busy = "1";
    if (meta) meta.textContent = t("reaching it…");
    try {
      const answer = await api("POST", "/api/web/machines", { action: "connect", host });
      if (!answer?.url) throw new Error(t("no link came back"));
      go(answer.url);
    } catch (error) {
      button.dataset.busy = "0";
      if (meta) meta.textContent = was;
      const why = el("p", "machine-error", t("Couldn't reach {name}: {why}", { name: button.dataset.name || host, why: error.message }));
      button.after(why);
    }
  }

  /** Read both lists and draw them into the panel. */
  async function fill() {
    const panel = document.getElementById("machines");
    if (!panel) return;
    panel.replaceChildren(el("p", "machine-why", t("Reading the machines…")));
    let machines = null;
    let bridge = null;
    try {
      machines = await api("GET", "/api/web/machines");
    } catch (error) {
      panel.replaceChildren(el("p", "machine-error", t("Couldn't read the machines: {why}", { why: error.message })));
      return;
    }
    // Remote access answers on its own: a cell without it still lists machines.
    try {
      bridge = await api("GET", "/api/web/bridge");
    } catch (error) {}
    panel.replaceChildren(...draw(machines), ...remote(bridge, false));
  }

  /** Turn remote access on or off, mint a code, or forget a device. */
  async function act(button) {
    if (button.dataset.busy === "1") return;
    const body = { action: button.dataset.act };
    if (button.dataset.index !== undefined) body.index = Number(button.dataset.index);
    button.dataset.busy = "1";
    try {
      await api("POST", "/api/web/bridge", body);
      await fill();
    } catch (error) {
      button.dataset.busy = "0";
      const why = el("p", "machine-error", t("Couldn't change remote access: {why}", { why: error.message }));
      button.after(why);
    }
  }

  return {
    /** Read the machines and draw them into the panel. */
    fill,
    /** A click inside the panel: choose a row, act on remote access, and keep
        the panel's clicks its own. */
    click(event) {
      event.stopPropagation();
      const action = event.target.closest("[data-act]");
      if (action) { void act(action); return; }
      const button = event.target.closest(".machine");
      if (button) void open(button);
    },
  };
}
