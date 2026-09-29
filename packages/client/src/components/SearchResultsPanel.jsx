import React, { useState, useMemo, useEffect, useRef } from "react";

const SORT_FIELDS = [
  { key: "name", label: "Filename" },
  { key: "size", label: "Size" },
  { key: "peer", label: "Peer" },
];
const INTERACTIVE_TARGET_SELECTOR = '[contenteditable], input, select, button, textarea';
const SEARCH_KEYBOARD_HINT_ID = "search-keyboard-hint";

export function SearchResultsPanel({ searchQuery, results, isBuddy, onDownload }) {
  const [sortField, setSortField] = useState("name");
  const [sortDir, setSortDir] = useState("asc");
  const [extFilter, setExtFilter] = useState("");
  const [selectedKey, setSelectedKey] = useState(null);
  const panelRef = useRef(null);

  const getResultKey = (r) => `${r.peer.id}:${r.file.path}`;
  const getFileExtension = (filename) => {
    const dot = filename.lastIndexOf(".");
    return dot > 0 ? filename.slice(dot + 1).toLowerCase() : null;
  };

  const formatSize = (bytes) => {
    if (!Number.isFinite(bytes) || bytes < 0) return "Unknown size";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const extensions = useMemo(() => {
    const exts = new Set();
    for (const r of results) {
      const ext = getFileExtension(r.file.name);
      if (ext) exts.add(ext);
    }
    return Array.from(exts).sort();
  }, [results]);

  const displayed = useMemo(() => {
    let filtered = results;
    if (extFilter) {
      filtered = filtered.filter((r) => {
        return getFileExtension(r.file.name) === extFilter;
      });
    }
    const sorted = [...filtered].sort((a, b) => {
      let av, bv;
      if (sortField === "name") {
        av = a.file.name.toLowerCase();
        bv = b.file.name.toLowerCase();
      } else if (sortField === "size") {
        av = a.file.size;
        bv = b.file.size;
      } else {
        av = a.peer.username.toLowerCase();
        bv = b.peer.username.toLowerCase();
      }
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [results, sortField, sortDir, extFilter]);

  useEffect(() => {
    if (displayed.length === 0) {
      setSelectedKey(null);
      return;
    }
    if (!selectedKey || !displayed.some((r) => getResultKey(r) === selectedKey)) {
      setSelectedKey(getResultKey(displayed[0]));
    }
  }, [displayed, selectedKey]);

  const selectedResult = useMemo(
    () => displayed.find((r) => getResultKey(r) === selectedKey) || null,
    [displayed, selectedKey],
  );
  const selectedIndex = useMemo(
    () => displayed.findIndex((r) => getResultKey(r) === selectedKey),
    [displayed, selectedKey],
  );

  const toggleSort = (field) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const sortArrow = (field) => {
    if (sortField !== field) return " ↕";
    return sortDir === "asc" ? " ↑" : " ↓";
  };

  const queueDownload = (result) => {
    if (!result) return;
    onDownload(result.file.path, result.peer.id, result.file.name);
  };

  const handlePanelKeyDown = (event) => {
    if (!displayed.length) return;
    if (event.target instanceof Element && event.target.closest(INTERACTIVE_TARGET_SELECTOR)) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const nextIndex = selectedIndex < 0 ? 0 : Math.min(displayed.length - 1, selectedIndex + 1);
      setSelectedKey(getResultKey(displayed[nextIndex]));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const nextIndex = selectedIndex <= 0 ? 0 : selectedIndex - 1;
      setSelectedKey(getResultKey(displayed[nextIndex]));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      queueDownload(selectedResult);
    }
  };

  return (
    <div
      ref={panelRef}
      className="search-results-panel"
      tabIndex={0}
      aria-describedby={SEARCH_KEYBOARD_HINT_ID}
      onKeyDown={handlePanelKeyDown}
    >
      <div className="search-results-header">
        <h3>
          Search Results — &quot;{searchQuery}&quot; ({displayed.length}
          {results.length >= 200 ? "+" : ""} matches)
        </h3>
        <div className="search-filter-row">
          {extensions.length > 0 && (
            <label className="search-ext-filter">
              Filter by type:&nbsp;
              <select
                value={extFilter}
                onChange={(e) => setExtFilter(e.target.value)}
                className="search-ext-select"
              >
                <option value="">All types</option>
                {extensions.map((ext) => (
                  <option key={ext} value={ext}>.{ext}</option>
                ))}
              </select>
            </label>
          )}
          <span className="search-keyboard-hint" id={SEARCH_KEYBOARD_HINT_ID}>
            Tip: Use Up/Down keys, then Enter to queue
          </span>
        </div>
      </div>
      {displayed.length === 0 ? (
        <p className="no-results">No files match your search across any online peer.</p>
      ) : (
        <>
          <table className="search-results-table">
            <thead>
              <tr>
                <th
                  className="sortable-col"
                  onClick={() => toggleSort("name")}
                  title="Sort by filename"
                >
                  File{sortArrow("name")}
                </th>
                <th>Path</th>
                <th
                  className="sortable-col"
                  onClick={() => toggleSort("size")}
                  title="Sort by size"
                >
                  Size{sortArrow("size")}
                </th>
                <th
                  className="sortable-col"
                  onClick={() => toggleSort("peer")}
                  title="Sort by peer"
                >
                  Peer{sortArrow("peer")}
                </th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {displayed.map((r) => {
                const resultKey = getResultKey(r);
                const isSelected = resultKey === selectedKey;
                return (
                  <tr
                    key={resultKey}
                    className={isSelected ? "search-result-selected" : ""}
                    onClick={() => setSelectedKey(resultKey)}
                    onDoubleClick={() => queueDownload(r)}
                  >
                    <td>📄 {r.file.name}</td>
                    <td className="search-result-path">{r.file.relativePath}</td>
                    <td>{formatSize(r.file.size)}</td>
                    <td>
                      👤 {r.peer.username}
                      {isBuddy(r.peer.id) && (
                        <span className="buddy-badge" title="Buddy">⭐</span>
                      )}
                    </td>
                    <td>
                      <button
                        className="btn-download"
                        onClick={() => setSelectedKey(resultKey)}
                      >
                        👁 Preview
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {selectedResult && (
            <div className="search-result-preview">
              <h4>Selected File Preview</h4>
              <div className="search-result-preview-grid">
                <div><strong>Name:</strong> {selectedResult.file.name}</div>
                <div><strong>Type:</strong> {getFileExtension(selectedResult.file.name) || "unknown"}</div>
                <div><strong>Size:</strong> {formatSize(selectedResult.file.size)}</div>
                <div>
                  <strong>Peer:</strong> {selectedResult.peer.username}
                  {isBuddy(selectedResult.peer.id) ? " ⭐ Buddy" : ""}
                </div>
              </div>
              <div className="search-result-preview-path">
                <strong>Path:</strong> {selectedResult.file.relativePath}
              </div>
              <button
                className="btn-download"
                onClick={() => queueDownload(selectedResult)}
              >
                ⬇ Queue Download
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
