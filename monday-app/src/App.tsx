import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ThemeProvider } from "@vibe/core";
import mondaySdk from "monday-sdk-js";
import BoardView from "./views/BoardView";

const monday = mondaySdk();
type Sys = "light" | "dark" | "black";

export default function App() {
  const [theme, setTheme] = useState<Sys>("light");

  useEffect(() => {
    const apply = (t?: string) => { if (t === "light" || t === "dark" || t === "black") setTheme(t); };
    monday.get("context").then((res: any) => apply(res?.data?.theme));
    monday.listen("context", (res: any) => apply(res?.data?.theme));
  }, []);

  return (
    <ThemeProvider systemTheme={theme}>
      <div style={{
        minHeight: "100vh",
        background: "var(--primary-background-color)",
        color: "var(--primary-text-color)",
        fontFamily: "var(--font-family, 'Figtree', Roboto, sans-serif)",
      }}>
        <BrowserRouter>
          <Routes>
            <Route path="/board" element={<BoardView />} />
            <Route path="*" element={<Navigate to="/board" replace />} />
          </Routes>
        </BrowserRouter>
      </div>
    </ThemeProvider>
  );
}
