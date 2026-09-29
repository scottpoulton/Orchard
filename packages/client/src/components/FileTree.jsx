import React from "react";

export function FileTree({ tree, onDownload, searchQuery = "" }) {
  if (!tree || tree.length === 0) return null;

  const filterTree = (items, query) => {
    if (!query) return items;
    return items.reduce((acc, entry) => {
      if (entry.type === "directory") {
        const filteredChildren = filterTree(entry.children || [], query);
        if (filteredChildren.length > 0) acc.push({ ...entry, children: filteredChildren });
      } else {
        if (entry.name.toLowerCase().includes(query.toLowerCase())) acc.push(entry);
      }
      return acc;
    }, []);
  };

  const filteredTree = filterTree(tree, searchQuery);
  if (filteredTree.length === 0) return <p className="no-results">No files match your search.</p>;

  return (
    <ul>
      {filteredTree.map((entry, idx) =>
        entry.type === "directory" ? (
          <li key={entry.id || entry.path || idx} className="directory">
            📁 {entry.name}
            <FileTree tree={entry.children} onDownload={onDownload} searchQuery={searchQuery} />
          </li>
        ) : (
          <li key={entry.id || entry.path || idx}>
            📄 {entry.name} ({(entry.size / 1024).toFixed(1)} KB)
            {onDownload && (
              <button onClick={() => onDownload(entry.path, entry.name)}>Download</button>
            )}
          </li>
        )
      )}
    </ul>
  );
}
