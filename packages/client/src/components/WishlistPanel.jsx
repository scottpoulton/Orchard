import React from "react";

export function WishlistPanel({ wishlistItems, wishlistMatches, wishlistQuery, onQueryChange, onAdd, onRemove, onSearch }) {
  return (
    <div className="peer-presence-panel">
      <strong>Wishlist (Saved Search)</strong>
      <div className="folder-actions">
        <input
          type="text"
          value={wishlistQuery}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onAdd()}
          placeholder="e.g. flac, remix, audiobook"
          className="buddy-input"
        />
        <button onClick={onAdd}>Add</button>
      </div>
      {wishlistItems.length === 0 ? (
        <p>No saved searches.</p>
      ) : (
        <ul className="peer-presence-list">
          {wishlistItems.map((item) => {
            const match = wishlistMatches.find((m) => m.query === item);
            return (
              <li key={item}>
                <strong>{item}</strong>
                {" — "}
                {match?.count > 0 ? (
                  <span className="wishlist-hit">🟢 {match.count} peer(s)</span>
                ) : (
                  <span className="wishlist-miss">⚪ 0 matches</span>
                )}
                <button
                  className="btn-wishlist-search"
                  onClick={() => onSearch(item)}
                  title="Search for this across all peers"
                  style={{ marginLeft: "0.5rem" }}
                >
                  Search
                </button>
                <button
                  onClick={() => onRemove(item)}
                  style={{ marginLeft: "0.25rem" }}
                  aria-label={`Remove "${item}" from wishlist`}
                  title={`Remove "${item}"`}
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
