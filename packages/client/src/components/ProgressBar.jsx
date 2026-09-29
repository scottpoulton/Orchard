import React from "react";

export function ProgressBar({ filename, loaded, total }) {
  if (!filename) return null;
  const percentage = total > 0 ? Math.round((loaded / total) * 100) : 0;
  const loadedMB = (loaded / (1024 * 1024)).toFixed(2);
  const totalMB = total > 0 ? (total / (1024 * 1024)).toFixed(2) : "?";
  return (
    <div className="progress-overlay">
      <div className="progress-container">
        <div className="progress-header">
          <span className="progress-icon">⬇️</span>
          <div className="progress-info">
            <div className="progress-filename">{filename}</div>
            <div className="progress-size">
              {loadedMB} MB / {totalMB} MB
            </div>
          </div>
        </div>
        <div className="progress-bar-container">
          <div className="progress-bar" style={{ width: `${percentage}%` }}></div>
        </div>
        <div className="progress-percentage">{percentage}%</div>
      </div>
    </div>
  );
}
