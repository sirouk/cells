// tailnet.js -- the Tailnet pill at the head of the page: which machine's page
// this is, how this machine is reached from the rest of the tailnet, and the
// way to every other machine there.
//
// Everything here is the tailnet access cell's (nodecode-web-remote): GET
// /api/remote is how access stands (on or off, its address, the pairing code,
// the paired devices), POST /api/remote acts on it, and GET /api/remote/peers
// lists the machines of the tailnet serving a page, the one answering first. A
// page without that cell answers 404 there, and the pill is not drawn.
//
// The pill's dot says where this page comes from: green on this machine's own
// loopback while it is serving the tailnet, blue when the page came over the
// tailnet from another machine, unlit on loopback with access off. Switching
// is a plain navigation to the other machine's address; a browser it has not
// paired is sent to that machine's pairing page, which asks for the code its
// own Tailnet panel shows. Access is turned on and off only on loopback: off,
// from over the tailnet, would cut the page off from the browser asking.
//
// The editor draws its own pill around a framed page (nodecode-vscode), so a
// framed page draws none: two controls for one thing read as two things.
import { el, button } from "./observe.js";
import { t } from "./i18n.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function makeTailnet({ api, toast, mark, panel }) {
  const local = LOOPBACK.has(location.hostname);
  let seen = null; // { access, machines } once read, { error } when the read failed

  function paint() {
    const access = seen?.access;
    mark.hidden = !seen;
    mark.dataset.where = !local ? "remote" : access?.running ? "local" : "";
    if (panel.hasAttribute("data-open")) panel.replaceChildren(...draw());
  }

  async function read() {
    try {
      const [access, peers] = await Promise.all([
        api("GET", "/api/remote"),
        api("GET", "/api/remote/peers").catch(() => null),
      ]);
      seen = { access, machines: peers?.machines || [] };
    } catch (error) {
      // No tailnet access cell in this organism: nothing to draw.
      if (error.status === 404) seen = null;
      else seen = { error: error.message, machines: seen?.machines || [] };
    }
    paint();
  }

  async function act(body) {
    try {
      const access = await api("POST", "/api/remote", body);
      const peers = await api("GET", "/api/remote/peers").catch(() => null);
      seen = { access, machines: peers?.machines || seen?.machines || [] };
      paint();
    } catch (error) {
      toast(t("Couldn't do that: {why}", { why: error.message }), { error: true });
      paint();
    }
  }

  function copy(text, said) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(() => toast(said), () => toast(t("Couldn't copy: the browser refused the clipboard"), { error: true }));
  }

  const row = (...parts) => {
    const node = el("div", "tn-row");
    node.append(...parts);
    return node;
  };
  const why = (text) => el("p", "tn-why", text);

  function draw() {
    if (!seen) return [why(t("Reading…"))];
    if (seen.error) return [why(t("Couldn't read tailnet access: {why}", { why: seen.error }))];
    const { access, machines } = seen;
    const parts = [];

    if (!access.available) {
      const advice = access.advice || {};
      parts.push(why(advice.text || t("This machine cannot be reached over a tailnet yet.")));
      if (advice.step) parts.push(why(advice.step));
      if (advice.url) {
        const go = el("a", "quiet", advice.label || t("Open"));
        go.href = advice.url;
        go.target = "_blank";
        go.rel = "noopener";
        parts.push(row(go));
      }
      return parts;
    }

    const head = [el("span", "tn-grow", t("This machine"))];
    if (local) {
      head.push(access.running
        ? button("quiet", t("Turn off"), { tn: "stop" })
        : button("solid", t("Turn on"), { tn: "start" }));
    }
    parts.push(row(...head));

    if (access.running) {
      parts.push(row(el("span", "tn-grow tn-addr", access.address || ""),
                     button("quiet", t("Copy"), { tn: "copy-address" })));
      if (access.code) {
        parts.push(row(el("code", "tn-grow tn-code", access.code),
                       button("quiet", t("Copy"), { tn: "copy-code" }),
                       button("quiet", t("New code"), { tn: "code" })));
        parts.push(why(t("Type it on the device to pair. Good for {n} minutes.", { n: access.code_minutes })));
      } else {
        parts.push(row(el("span", "tn-grow tn-dim", t("No code standing.")),
                       button("quiet", t("New code"), { tn: "code" })));
      }
    }

    // Shown whenever there is another machine, or this page is another
    // machine's: the list is the way back.
    if (machines.length > 1 || !local) {
      parts.push(el("p", "micro tn-head", t("Machines on your tailnet")));
      for (const machine of machines) {
        const dot = el("span", "tn-dot");
        if (machine.current) dot.dataset.where = local ? "local" : "remote";
        const name = el("span", "tn-grow", machine.name);
        if (machine.current) name.append(el("span", "tn-dim", ` · ${t("showing")}`));
        const line = row(dot, name);
        if (!machine.current && machine.address) {
          const go = el("a", "quiet", t("Switch"));
          go.href = machine.address;
          line.append(go);
        }
        parts.push(line);
      }
    }

    if (access.devices?.length) {
      parts.push(el("p", "micro tn-head", t("Paired devices")));
      for (const device of access.devices) {
        const name = el("span", "tn-grow", device.name);
        if (device.login) name.append(el("span", "tn-dim", ` · ${device.login}`));
        if (device.index === access.this_device) name.append(el("span", "tn-dim", ` · ${t("this browser")}`));
        parts.push(row(name, button("quiet", t("Forget"), { tn: "forget", index: String(device.index) })));
      }
    }
    if (access.refusal) parts.push(why(access.refusal));
    return parts;
  }

  return {
    /** Read how tailnet access stands, and paint the pill (and the panel, when open). */
    read,
    /** The pill was pressed: draw what is known at once, and read it again. */
    open() {
      panel.replaceChildren(...draw());
      void read();
    },
    /** A click inside the panel: keep it there, and do what it asked. */
    click(event) {
      event.stopPropagation();
      const target = event.target.closest("[data-tn]");
      if (!target || target.dataset.busy) return;
      const what = target.dataset.tn;
      const access = seen?.access;
      if (what === "copy-address") return copy(access?.address || "", t("Copied the address"));
      if (what === "copy-code") return copy(access?.code || "", t("Copied the code"));
      target.dataset.busy = "1";
      void act(what === "forget" ? { action: "forget", index: Number(target.dataset.index) } : { action: what });
    },
  };
}
