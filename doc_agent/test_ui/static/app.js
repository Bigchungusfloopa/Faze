// Temporary Test UI client logic
document.addEventListener("DOMContentLoaded", () => {
  const sessionId = "session_" + Math.random().toString(36).substring(2, 9);
  document.getElementById("session-tag").textContent = "Session: " + sessionId;

  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");
  const btnLoadSamples = document.getElementById("btn-load-samples");
  const btnReset = document.getElementById("btn-reset");
  const fileList = document.getElementById("file-list");
  const fileCount = document.getElementById("file-count");
  const chatMessages = document.getElementById("chat-messages");
  const userInput = document.getElementById("user-input");
  const btnSend = document.getElementById("btn-send");
  const engineDot = document.getElementById("engine-dot");
  const engineTitle = document.getElementById("engine-title");
  const engineMeta = document.getElementById("engine-meta");
  const btnToggleEngine = document.getElementById("btn-toggle-engine");

  let currentUseMock = false;

  // Load Status on startup
  fetchStatus();

  btnToggleEngine.addEventListener("click", async () => {
    btnToggleEngine.disabled = true;
    try {
      const targetMode = !currentUseMock;
      const res = await fetch("/api/toggle-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ use_mock: targetMode }),
      });
      const data = await res.json();
      appendBotNotice(data.message);
      await fetchStatus();
    } catch (err) {
      alert("Toggle error: " + err);
    } finally {
      btnToggleEngine.disabled = false;
    }
  });

  // File Upload Handlers
  dropZone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => {
    if (e.target.files.length > 0) {
      handleFiles(Array.from(e.target.files));
    }
  });

  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });

  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("dragover");
  });

  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    if (e.dataTransfer.files.length > 0) {
      handleFiles(Array.from(e.dataTransfer.files));
    }
  });

  // Load Samples
  btnLoadSamples.addEventListener("click", async () => {
    btnLoadSamples.disabled = true;
    btnLoadSamples.textContent = "Loading synthetic docs...";
    try {
      const res = await fetch("/api/load-samples", { method: "POST" });
      const data = await res.json();
      appendBotNotice(`Loaded ${data.loaded} synthetic sample documents across all 4 pipelines (Text, Table, Scanned OCR, Image). Ready to query!`);
      await fetchStatus();
    } catch (err) {
      alert("Failed to load sample docs: " + err);
    } finally {
      btnLoadSamples.disabled = false;
      btnLoadSamples.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
        </svg>
        Load 5 Synthetic Sample Docs`;
    }
  });

  // Reset Session
  btnReset.addEventListener("click", async () => {
    if (!confirm("Are you sure you want to reset the agent session and documents?")) return;
    try {
      await fetch("/api/reset", { method: "POST" });
      chatMessages.innerHTML = "";
      appendBotNotice("Agent session reset. Upload new files or load samples to begin.");
      await fetchStatus();
    } catch (err) {
      alert("Reset error: " + err);
    }
  });

  // Chat Input Handling
  btnSend.addEventListener("click", sendMessage);
  userInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea
  userInput.addEventListener("input", () => {
    userInput.style.height = "auto";
    userInput.style.height = Math.min(userInput.scrollHeight, 120) + "px";
  });

  // Suggestion Chips
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const prompt = chip.getAttribute("data-prompt");
      userInput.value = prompt;
      sendMessage();
    });
  });

  async function handleFiles(files) {
    for (const f of files) {
      const formData = new FormData();
      formData.append("file", f);
      try {
        const res = await fetch("/api/upload", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          appendBotNotice(`Upload failed for <strong>${escapeHtml(f.name)}</strong>: ${escapeHtml(errData.detail || "Server error (" + res.status + ")")}`);
          continue;
        }
        const info = await res.json();
        if (info.status === "rejected") {
          appendBotNotice(`File <strong>${escapeHtml(info.filename)}</strong> was rejected: ${escapeHtml(info.reason || "unsupported format")}`);
        } else {
          appendBotNotice(`Ingested <strong>${escapeHtml(info.filename)}</strong> via <code>${escapeHtml(info.pipeline)}</code> pipeline (${info.chunk_count} chunks).`);
        }
      } catch (err) {
        appendBotNotice(`Upload error: ${escapeHtml(err.message)}`);
        console.error(err);
      }
    }
    await fetchStatus();
  }

  async function fetchStatus() {
    try {
      const res = await fetch("/api/status");
      const data = await res.json();
      
      currentUseMock = !data.is_real_gemini;
      engineTitle.textContent = data.engine;
      engineMeta.textContent = `Model: ${data.model}`;
      btnToggleEngine.textContent = data.is_real_gemini ? "Switch to Mock (Offline)" : "Switch to Real Gemini";
      
      if (data.is_real_gemini) {
        engineDot.classList.remove("mock");
      } else {
        engineDot.classList.add("mock");
      }

      fileCount.textContent = data.ingested_count;
      renderFileList(data.files || []);
    } catch (err) {
      console.error("Status fetch failed", err);
    }
  }

  function renderFileList(files) {
    if (!files || files.length === 0) {
      fileList.innerHTML = `<div class="empty-files">No documents ingested yet.<br>Upload files or load samples above.</div>`;
      return;
    }

    fileList.innerHTML = files.map((f) => `
      <div class="file-item">
        <div class="file-header">
          <span class="file-name" title="${f.filename}">${f.filename}</span>
          <span class="pipeline-badge badge-${f.pipeline}">${f.pipeline}</span>
        </div>
        <div class="file-meta">
          Chunks: ${f.chunk_count || 0} • Status: ${f.status}
        </div>
      </div>
    `).join("");
  }

  async function sendMessage() {
    const text = userInput.value.trim();
    if (!text) return;

    appendUserMessage(text);
    userInput.value = "";
    userInput.style.height = "auto";
    btnSend.disabled = true;

    const loadingId = appendLoadingMessage();

    try {
      const res = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text, session_id: sessionId }),
      });
      const data = await res.json();
      replaceLoadingWithResponse(loadingId, data, text);
    } catch (err) {
      removeLoading(loadingId);
      appendBotNotice(`Error contacting agent: ${err.message}`);
    } finally {
      btnSend.disabled = false;
      userInput.focus();
    }
  }

  function appendUserMessage(text) {
    const wrapper = document.createElement("div");
    wrapper.className = "message-wrapper user";
    wrapper.innerHTML = `
      <div class="avatar">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
          <circle cx="12" cy="7" r="4"></circle>
        </svg>
      </div>
      <div class="message-body">
        <div class="message-text">${escapeHtml(text)}</div>
      </div>
    `;
    chatMessages.appendChild(wrapper);
    scrollToBottom();
  }

  function appendLoadingMessage() {
    const id = "loading_" + Date.now();
    const wrapper = document.createElement("div");
    wrapper.className = "message-wrapper assistant";
    wrapper.id = id;
    wrapper.innerHTML = `
      <div class="avatar">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 14.93V18h-2v-1.07A4.01 4.01 0 0 1 8 13h2a2 2 0 1 0 4 0c0-1.5-2-1.75-2-3.5V9h2v.5c0 1.25 2 1.5 2 3.5a4.01 4.01 0 0 1-3 3.93zM12 5a1.5 1.5 0 1 1-1.5 1.5A1.5 1.5 0 0 1 12 5z"></path>
        </svg>
      </div>
      <div class="message-body">
        <div class="message-text" style="color: var(--text-muted); font-style: italic;">
          Retrieving relevant chunks & validating grounding...
        </div>
      </div>
    `;
    chatMessages.appendChild(wrapper);
    scrollToBottom();
    return id;
  }

  function removeLoading(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }

  const _messageStore = {};

  function replaceLoadingWithResponse(id, data, question) {
    const el = document.getElementById(id);
    if (!el) return;

    _messageStore[id] = { question: question || "", answer: data.answer || "" };

    // Badges based on verified status
    let badgesHtml = '<div class="result-meta-card">';
    if (data.status === "verified" || data.grounded) {
      badgesHtml += `<span class="tag-verified">✓ Verified (Source of Truth)</span>`;
    }
    if (data.status === "clarification_required") {
      badgesHtml += `<span class="tag-clarification">? Clarification Required</span>`;
    }
    if (data.status === "conflicting_information" || data.conflicting) {
      badgesHtml += `<span class="tag-conflict">⚠️ Conflicting Sources Detected</span>`;
    }
    if (data.status === "insufficient_information" || data.insufficient_evidence) {
      badgesHtml += `<span class="tag-insufficient">✕ Insufficient Information</span>`;
    }
    badgesHtml += `</div>`;

    // Conflict Resolution Action Banner (Prominent when conflict occurs)
    let conflictActionHtml = "";
    if (data.status === "conflicting_information" || data.conflicting) {
      conflictActionHtml = `
        <div class="conflict-resolution-action">
          <div class="conflict-prompt-text">
            <span class="pulse-dot"></span>
            <strong>Contradiction Detected:</strong> Multiple sources in the uploaded documents provide conflicting information.
          </div>
          <button class="btn-conflict-resolve" id="btn_resolve_${id}" onclick="window.triggerLLMResolution('${id}')">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
            </svg>
            ⚡ Resolve Conflict via LLM Search (Get Optimal Answer)
          </button>
        </div>
      `;
    }

    // Optional response action button (appears on every response)
    const optionalActionHtml = `
      <div class="message-actions-bar">
        <button class="btn-llm-search-opt" id="btn_opt_${id}" onclick="window.triggerLLMResolution('${id}')" title="Synthesize deep domain context and resolve discrepancies using dedicated LLM engine">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
          </svg>
          <span>⚡ Get Optimal Answer via LLM Search</span>
        </button>
      </div>
      <div id="resolution_${id}" class="resolution-container"></div>
    `;

    // Clarification Options
    let clarificationHtml = "";
    if (data.clarification_options && data.clarification_options.length > 0) {
      clarificationHtml = `
        <div class="clarification-box">
          <div class="clarification-header">Select candidate column to proceed:</div>
          <div class="clarification-options">
            ${data.clarification_options.map((opt) => `
              <button class="clarification-chip" onclick="window.selectClarification('${escapeHtml(opt)}')">
                ${escapeHtml(opt)}
              </button>
            `).join("")}
          </div>
        </div>
      `;
    }

    // Deterministic Evidence Cards (Section 15 & 16)
    let evidenceHtml = "";
    if (data.evidence && data.evidence.length > 0) {
      evidenceHtml = `
        <div class="evidence-box">
          <div class="evidence-header">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            Deterministic Evidence & Provenance (${data.evidence.length})
          </div>
          <div class="evidence-grid">
            ${data.evidence.map((ev) => `
              <div class="evidence-card">
                ${ev.file ? `<div class="ev-row"><span class="ev-label">File</span><span class="ev-val">${escapeHtml(ev.file)}</span></div>` : ""}
                ${ev.sheet ? `<div class="ev-row"><span class="ev-label">Sheet</span><span class="ev-val">${escapeHtml(ev.sheet)}</span></div>` : ""}
                ${ev.cell ? `<div class="ev-row"><span class="ev-label">Cell</span><span class="ev-val ev-code">${escapeHtml(ev.cell)}</span></div>` : ""}
                ${ev.columns ? `<div class="ev-row"><span class="ev-label">Columns</span><span class="ev-val ev-code">${escapeHtml(Array.isArray(ev.columns) ? ev.columns.join(", ") : String(ev.columns))}</span></div>` : ""}
                ${ev.operation ? `<div class="ev-row"><span class="ev-label">Operation</span><span class="ev-val">${escapeHtml(ev.operation)}</span></div>` : ""}
                ${ev.filter ? `<div class="ev-row"><span class="ev-label">Filter</span><span class="ev-val">${escapeHtml(ev.filter)}</span></div>` : ""}
                ${ev.join_key ? `<div class="ev-row"><span class="ev-label">Join Key</span><span class="ev-val">${escapeHtml(ev.join_key)}</span></div>` : ""}
                ${ev.rows_analyzed !== undefined ? `<div class="ev-row"><span class="ev-label">Rows Analyzed</span><span class="ev-val">${ev.rows_analyzed.toLocaleString()}</span></div>` : ""}
                ${ev.missing_values_excluded ? `<div class="ev-row"><span class="ev-label">Nulls Excluded</span><span class="ev-val">${ev.missing_values_excluded}</span></div>` : ""}
                ${ev.result !== undefined ? `<div class="ev-row ev-result"><span class="ev-label">Result</span><span class="ev-val ev-res-val">${typeof ev.result === "object" ? escapeHtml(JSON.stringify(ev.result)) : escapeHtml(String(ev.result))}</span></div>` : ""}
              </div>
            `).join("")}
          </div>
        </div>
      `;
    }

    // Citations (for prose documents)
    let citationsHtml = "";
    if (data.citations && data.citations.length > 0 && (!data.evidence || data.evidence.length === 0)) {
      citationsHtml = `
        <div class="citations-box">
          <div class="citations-header">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path>
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>
            </svg>
            Evidence & Citations (${data.citations.length})
          </div>
          <div class="citation-list">
            ${data.citations.map((c) => `
              <div class="citation-item">
                <span class="citation-source">${escapeHtml(c.filename)} [p. ${c.page}, ${c.chunk_type}]</span>
                <div class="citation-snippet">"${escapeHtml(c.snippet.substring(0, 140))}${c.snippet.length > 140 ? "..." : ""}"</div>
              </div>
            `).join("")}
          </div>
        </div>
      `;
    }

    el.innerHTML = `
      <div class="avatar">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 14.93V18h-2v-1.07A4.01 4.01 0 0 1 8 13h2a2 2 0 1 0 4 0c0-1.5-2-1.75-2-3.5V9h2v.5c0 1.25 2 1.5 2 3.5a4.01 4.01 0 0 1-3 3.93zM12 5a1.5 1.5 0 1 1-1.5 1.5A1.5 1.5 0 0 1 12 5z"></path>
        </svg>
      </div>
      <div class="message-body">
        <div class="message-text">${formatAnswer(data.answer)}</div>
        ${badgesHtml}
        ${conflictActionHtml}
        ${clarificationHtml}
        ${evidenceHtml}
        ${citationsHtml}
        ${optionalActionHtml}
      </div>
    `;
    scrollToBottom();
  }

  window.triggerLLMResolution = async function(id) {
    const item = _messageStore[id];
    if (!item) return;

    const btnResolve = document.getElementById(`btn_resolve_${id}`);
    const btnOpt = document.getElementById(`btn_opt_${id}`);
    const container = document.getElementById(`resolution_${id}`);
    if (!container) return;

    if (btnResolve) {
      btnResolve.disabled = true;
      btnResolve.innerHTML = `<span class="spinner-small"></span> Resolving via LLM Search...`;
    }
    if (btnOpt) {
      btnOpt.disabled = true;
      btnOpt.innerHTML = `<span class="spinner-small"></span> Resolving via LLM Search...`;
    }

    container.innerHTML = `
      <div class="llm-resolution-card" style="opacity: 0.85;">
        <div style="display: flex; align-items: center; gap: 10px; font-size: 0.82rem; color: #c4b5fd;">
          <span class="spinner-small"></span>
          Running LLM Search & Conflict Resolution Engine with dedicated key...
        </div>
      </div>
    `;
    scrollToBottom();

    try {
      const res = await fetch("/api/resolve-conflict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: item.question,
          answer_context: item.answer,
          session_id: sessionId,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.detail || `Server error (${res.status})`);
      }

      const resData = await res.json();
      container.innerHTML = `
        <div class="llm-resolution-card">
          <div class="llm-resolution-header">
            <div class="llm-header-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
              </svg>
              <strong>Optimal Answer & Conflict Resolution (LLM Search)</strong>
            </div>
            <span class="llm-engine-tag">Dedicated Key: ${escapeHtml(resData.key_used_prefix || "Active")}</span>
          </div>
          <div class="llm-resolution-body">${formatAnswer(resData.answer)}</div>
        </div>
      `;

      if (btnResolve) {
        btnResolve.disabled = true;
        btnResolve.innerHTML = `✓ Conflict Resolved via LLM Search`;
        btnResolve.style.background = "rgba(16, 185, 129, 0.25)";
        btnResolve.style.borderColor = "rgba(16, 185, 129, 0.5)";
      }
      if (btnOpt) {
        btnOpt.disabled = true;
        btnOpt.innerHTML = `✓ Optimal Resolution Generated`;
      }
      scrollToBottom();
    } catch (err) {
      container.innerHTML = `
        <div class="llm-resolution-card" style="border-color: rgba(239, 68, 68, 0.4); background: rgba(239, 68, 68, 0.1);">
          <div style="color: #fca5a5; font-size: 0.82rem;">
            Failed to generate LLM resolution: ${escapeHtml(err.message)}
          </div>
        </div>
      `;
      if (btnResolve) {
        btnResolve.disabled = false;
        btnResolve.innerHTML = `⚡ Retry LLM Search Resolution`;
      }
      if (btnOpt) {
        btnOpt.disabled = false;
        btnOpt.innerHTML = `⚡ Retry LLM Search`;
      }
    }
  };

  window.selectClarification = function(colName) {
    userInput.value = `What is the average of ${colName}?`;
    handleSend();
  };

  function appendBotNotice(msgHtml) {
    const wrapper = document.createElement("div");
    wrapper.className = "message-wrapper assistant";
    wrapper.innerHTML = `
      <div class="avatar" style="background: rgba(99, 102, 241, 0.2);">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="16" x2="12" y2="12"></line>
          <line x1="12" y1="8" x2="12.01" y2="8"></line>
        </svg>
      </div>
      <div class="message-body">
        <div class="message-text" style="font-size: 0.85rem; padding: 10px 14px; background: rgba(99, 102, 241, 0.1); border-color: rgba(99, 102, 241, 0.3);">
          ${msgHtml}
        </div>
      </div>
    `;
    chatMessages.appendChild(wrapper);
    scrollToBottom();
  }

  function formatAnswer(text) {
    if (!text) return "";
    let html = escapeHtml(text);
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/^### (.*$)/gim, '<h4 style="margin: 8px 0 4px; color: #c4b5fd;">$1</h4>');
    html = html.replace(/^## (.*$)/gim, '<h3 style="margin: 10px 0 6px; color: #fff;">$1</h3>');
    html = html.replace(/^- (.*$)/gim, '<li style="margin-left: 18px; margin-bottom: 2px;">$1</li>');
    html = html.replace(/\n/g, "<br>");
    return html;
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
});
