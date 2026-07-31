import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, NavLink } from "react-router-dom";
import mondaySdk from "monday-sdk-js";
import BoardView from "./views/BoardView";
import CompaniesView from "./views/CompaniesView";
import { ConfirmProvider } from "./confirm";

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
      <ConfirmProvider>
        <BrowserRouter>
          <nav className="dc-topnav">
            <NavLink to="/board" className={({ isActive }) => "dc-topnav-tab" + (isActive ? " on" : "")}>Deals</NavLink>
            <NavLink to="/companies" className={({ isActive }) => "dc-topnav-tab" + (isActive ? " on" : "")}>Companies</NavLink>
          </nav>
          <Routes>
            <Route path="/board" element={<BoardView />} />
            <Route path="/companies" element={<CompaniesView />} />
            <Route path="*" element={<Navigate to="/board" replace />} />
          </Routes>
        </BrowserRouter>
      </ConfirmProvider>
    </div>
  );
}
