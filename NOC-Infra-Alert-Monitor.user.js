// ==UserScript==
// @name         NOC Infra Alert Monitor
// @namespace    http://tampermonkey.net/
// @version      2.0
// @match        https://app.xiteit.co/*
// @run-at       document-idle
// @description
// @grant        GM_xmlhttpRequest
// @connect      github.com
// ==/UserScript==

(function () {
    'use strict';

    // -----------------------------
    // GUARD (prevents double init)
    // -----------------------------
    if (window.__TM_QTREE_ALERT_RUNNING__) return;
    window.__TM_QTREE_ALERT_RUNNING__ = true;
    // -----------------------------
    // CONFIG
    // -----------------------------
    let targetStrings = [];
    let soundEnabled = false;

    const url = "https://raw.githubusercontent.com/ophirbm/NOC-Infra/refs/heads/main/AlertsMonitorConfig.json";

    async function loadTargets() {
        const res = await fetch(url);
        const data = await res.json();

        targetStrings = data.targets || ["FCSW", "DSW"];
        soundEnabled = data.settings?.soundEnabled ?? false;

        console.log("Sound enabled:", soundEnabled);
        console.log("Loaded targets:", targetStrings);
    }

    const ctx = new (window.AudioContext || window.webkitAudioContext)();

    function beep() {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = "sine";
        osc.frequency.value = 800;

        gain.gain.value = 0.1;

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start();
        osc.stop(ctx.currentTime + 0.2);
    }

    // Nodes permanently dismissed
    const dismissedAlerts = new Set();

    // Currently active matches
    let activeMatches = new Map();
    // key: node, value: {target, text}

    // UI refs
    let overlay = null;
    let panel = null;

    const style = document.createElement("style");
    style.textContent = `
    .tm-alert-node {
        background-color: rgba(255, 0, 0, 0.3) !important;
    }
    .tm-btn {
    width: 100%;
    padding: 10px 12px;
    margin-top: 10px;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease-in-out;
    letter-spacing: 0.3px;
}

.tm-btn-danger {
    background: #e74c3c;
    color: white;
    box-shadow: 0 2px 6px rgba(231, 76, 60, 0.3);
}

.tm-btn-danger:hover {
    background: #ff5a4d;
    transform: translateY(-1px);
    box-shadow: 0 4px 10px rgba(231, 76, 60, 0.4);
}

.tm-btn-danger:active {
    transform: translateY(0px);
    box-shadow: 0 2px 4px rgba(231, 76, 60, 0.3);
}

.tm-btn:focus {
    outline: none;
}
#tm-alert-list {
    flex: 1;
    overflow-y: auto;
    margin: 0;
    padding-left: 18px;
    max-height: 50vh;
}
`;
document.head.appendChild(style);

    // -----------------------------
    // CORE MATCH LOGIC (single node)
    // -----------------------------

    function normalizeText(text) {
        return text
            .replace(/\d+[smhd]/gi, "")
            .replace(/[smhd]\d+/gi, "")
            .replace(/\s+/g, " ")
            .trim();
    }
    function getAlertKey(node, target) {
        const text = normalizeText(node.textContent || "");
        return `${target}|${text}`;
    }

    function checkNode(node, newMatches) {
        const text = normalizeText(node.textContent) || "";

        for (let i = 0; i < targetStrings.length; i++) {
            if (text.includes(targetStrings[i])) {
                const key = getAlertKey(node, targetStrings[i]);
                if (dismissedAlerts.has(key)) {
                    return;
                }
                if (soundEnabled){
                    beep();
                }
                newMatches.set(key, {
                    key,
                    target: targetStrings[i],
                    text: text
                });

                node.classList.add("tm-alert-node");
                return;
            }
        }

        node.classList.remove("tm-alert-node");
    }

    // -----------------------------
    // UI
    // -----------------------------
    function ensureUI() {
        if (panel) return;

        overlay = document.createElement("div");
        overlay.style.cssText = `
            position:fixed;
            inset:0;
            background:red;
            opacity:0.6;
            z-index:999998;
            pointer-events:none;
            animation:pulse 1.5s infinite;
        `;

        const style = document.createElement("style");
        style.textContent = `
            @keyframes pulse {
                0% { opacity: 0; }
                50% { opacity: 0.6; }
                100% { opacity: 0; }
            }
        `;

        panel = document.createElement("div");
        panel.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 999999;


    max-width: 50vw;
    max-height: 50vh;

    background: #fff;
    padding: 12px;
    border-radius: 8px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.3);

    font-family: Arial;
    display: flex;
    flex-direction: column;
`;

        panel.innerHTML = `
            <div style="font-weight:bold;margin-bottom:8px;">
                Active critical alerts:
            </div>
            <ul id="tm-alert-list"></ul>
            <button id="tm-dismiss" class="tm-btn tm-btn-danger">
                Dismiss
            </button>
        `;

        document.head.appendChild(style);
        document.body.appendChild(overlay);
        document.body.appendChild(panel);

        document.getElementById("tm-dismiss").onclick = () => {
            // permanently ignore current matches
            for (const match of activeMatches.values()) {
                dismissedAlerts.add(match.key);
            }

            activeMatches.clear();
            destroyUI();
        };
    }

    function destroyUI() {
        overlay?.remove();
        panel?.remove();
        overlay = null;
        panel = null;
    }

    function renderUI() {
        const list = document.getElementById("tm-alert-list");
        if (!list) return;

        list.innerHTML = [...activeMatches.values()]
            .map(m => `<li><b>${m.target}</b><br>${m.text}</li>`)
            .join("");
    }

    function updateUI() {
        if (activeMatches.size === 0) {
            destroyUI();
            return;
        }

        ensureUI();
        renderUI();
    }

    // -----------------------------
    // OBSERVER (incremental only)
    // -----------------------------
    function startObserver() {
        setInterval(scanAllNodes, 1000);
        console.log("Observer started");
    }

    function scanAllNodes() {
        let team = document.getElementById("customer-picker-text")?.innerText || "Infra-NOC";
    console.log("You are connected as "+team);
        const nodes = document.querySelectorAll(".q-tree__node");

        const newMatches = new Map();

        for (const node of nodes) {
            checkNode(node, newMatches);
        }

        activeMatches = newMatches;

        updateUI();
    }

    // -----------------------------
    // BOOTSTRAP (wait for tree)
    // -----------------------------
    function boot() {
        const nodes = document.querySelectorAll(".q-tree__node");

        if (nodes.length === 0) {
            setTimeout(boot, 500);
            return;
        }

        console.log("Tree ready:", nodes.length);

        scanAllNodes();
        startObserver();
    }

    loadTargets().then(() => {
    boot();
});

})();
