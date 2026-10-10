"use client";
import { useEffect, useState } from "react";

type Theme = "light" | "dark";

/** Light is the default. The choice is remembered per device (localStorage, failure-tolerant). */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  }, []);

  function choose(t: Theme) {
    setTheme(t);
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem("rp-theme", t);
    } catch {
      /* storage unavailable: choice just won't persist */
    }
  }

  return (
    <div className="theme" role="group" aria-label="Colour theme">
      <button type="button" aria-pressed={theme === "light"} onClick={() => choose("light")}>☀ Light</button>
      <button type="button" aria-pressed={theme === "dark"} onClick={() => choose("dark")}>☾ Dark</button>
    </div>
  );
}
