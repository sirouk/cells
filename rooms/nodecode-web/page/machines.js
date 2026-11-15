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
import { iconButton } from "./icons.js";
import { t } from "./i18n.js";

export function makeMachines({ api, toast }) {
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
  /** A small button that puts TEXT on the clipboard, and says that it did. */
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
    // Tailnet access is not drawn here: this panel is the page's list of other
    // organisms, and the editor's own Tailnet mark is the one place to turn it
    // on and see who is paired. Two controls for one thing read as two things.
    panel.replaceChildren(...draw(machines));
  }

  return {
    /** Read the machines and draw them into the panel. */
    fill,
    /** A click inside the panel: choose a machine, and keep the panel's clicks
        its own. */
    click(event) {
      event.stopPropagation();
      const button = event.target.closest(".machine");
      if (button) void open(button);
    },
  };
}
