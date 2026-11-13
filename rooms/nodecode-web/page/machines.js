// machines.js -- the other organisms this one can switch to.
//
// The list is the cell's (GET /api/web/machines): the organism serving this tab,
// the other homes on this machine, and the instances the operator's tailnet
// answers for. A gateway answers at 127.0.0.1 only -- it refuses any other Host,
// which is how it keeps a rebound name from reaching it -- so a peer is not
// reachable over its tailnet address at all. Choosing one asks the cell to open a
// loopback forward over the operator's own ssh (POST, action connect) and the tab
// then moves to that loopback link, which is a page of its own origin with its
// own token: a navigation, not a frame.
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

  function group(text) {
    return el("div", "machine-group", t(text));
  }

  function draw(data) {
    const parts = [group("Machines")];
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
      parts.push(group("On this machine"));
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
      parts.push(group("Your tailnet"));
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

  return {
    /** Read the machines and draw them into the panel. */
    async fill() {
      const panel = document.getElementById("machines");
      if (!panel) return;
      panel.replaceChildren(el("p", "machine-why", t("Reading the machines…")));
      try {
        panel.replaceChildren(...draw(await api("GET", "/api/web/machines")));
      } catch (error) {
        panel.replaceChildren(el("p", "machine-error", t("Couldn't read the machines: {why}", { why: error.message })));
      }
    },
    /** A click inside the panel: choose a row, and keep the panel's clicks its own. */
    click(event) {
      event.stopPropagation();
      const button = event.target.closest(".machine");
      if (button) void open(button);
    },
  };
}
