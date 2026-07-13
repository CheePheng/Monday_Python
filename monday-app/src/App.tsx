import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import mondaySdk from "monday-sdk-js";
import BoardView from "./views/BoardView";

const monday = mondaySdk();

export default function App() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const apply = (t?: string) => setTheme(t === "dark" || t === "black" ? "dark" : "light");
    monday.get("context").then((res: any) => apply(res?.data?.theme));
    monday.listen("context", (res: any) => apply(res?.data?.theme));
  }, []);

  return (
    <div className="dc-root" data-theme={theme}>
      <BrowserRouter>
        <Routes>
          <Route path="/board" element={<BoardView />} />
          <Route path="*" element={<Navigate to="/board" replace />} />
        </Routes>
      </BrowserRouter>
    </div>
  );
}
