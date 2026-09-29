import React, { useState } from "react";
import { config } from "../config.js";

export function AuthScreen({ onLogin }) {
  const [mode, setMode] = useState("login");
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [issuedRecoveryCode, setIssuedRecoveryCode] = useState("");
  const [loading, setLoading] = useState(false);
  const inRecoveryMode = mode === "recovery";

  const switchToLogin = () => {
    setMode("login");
    setIsLogin(true);
    setPassword("");
    setRecoveryCode("");
    setNewPassword("");
    setError("");
  };

  const switchToRegister = () => {
    setMode("register");
    setIsLogin(false);
    setRecoveryCode("");
    setNewPassword("");
    setError("");
  };

  const switchToRecovery = () => {
    setMode("recovery");
    setIsLogin(false);
    setPassword("");
    setError("");
    setSuccess("");
    setIssuedRecoveryCode("");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(""); setSuccess(""); setLoading(true);
    try {
      const endpoint = inRecoveryMode ? "/recovery/reset-password" : (isLogin ? "/login" : "/register");
      const body = inRecoveryMode
        ? { username, recoveryCode, newPassword }
        : { username, password };
      const response = await fetch(`${config.serverUrl}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.message || "An error occurred");
        setLoading(false);
        return;
      }
      if (inRecoveryMode) {
        setError("");
        setIssuedRecoveryCode(data.recoveryCode || "");
        setSuccess("Password reset successful. Save your new recovery code and log in.");
        setRecoveryCode("");
        setNewPassword("");
        setPassword("");
        switchToLogin();
      } else if (isLogin) {
        onLogin(data.token, username);
      } else {
        setError("");
        setIssuedRecoveryCode(data.recoveryCode || "");
        setSuccess("Registration successful! Save your recovery code, then log in.");
        switchToLogin();
        setPassword("");
        setTimeout(() => setSuccess(""), 3000);
      }
    } catch {
      setError("Failed to connect to server. Is it running?");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-container">
      <h1>Orchard</h1>
      <h2>{inRecoveryMode ? "Recover Account" : (isLogin ? "Login" : "Register")}</h2>
      <form onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
        <input
          type={inRecoveryMode ? "text" : "password"}
          placeholder={inRecoveryMode ? "Recovery code (shown at registration)" : "Password"}
          value={inRecoveryMode ? recoveryCode : password}
          onChange={(e) => inRecoveryMode ? setRecoveryCode(e.target.value) : setPassword(e.target.value)}
          required
        />
        {inRecoveryMode && (
          <input
            type="password"
            placeholder="New password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
          />
        )}
        {error && <div className="error">{error}</div>}
        {success && <div className="success">{success}</div>}
        {issuedRecoveryCode && (
          <div className="success">
            Recovery code (save this securely): <strong>{issuedRecoveryCode}</strong>
          </div>
        )}
        <button type="submit" disabled={loading}>
          {loading ? "Loading..." : inRecoveryMode ? "Reset Password" : (isLogin ? "Login" : "Register")}
        </button>
      </form>
      {inRecoveryMode ? (
        <button onClick={switchToLogin} className="switch-btn">
          Back to Login
        </button>
      ) : (
        <>
          <button onClick={() => (isLogin ? switchToRegister() : switchToLogin())} className="switch-btn">
            {isLogin ? "Need an account? Register" : "Have an account? Login"}
          </button>
          <button onClick={switchToRecovery} className="switch-btn">
            Forgot password? Use recovery code
          </button>
        </>
      )}
    </div>
  );
}
