import { useEffect, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";

interface TopNavProps {
  variant?: "app" | "auth";
}

const menuItems = [
  { to: "/home", label: "계약서 분석" },
  { to: "/analysis", label: "위험 리포트" },
  { to: "/map", label: "안심 시그널 맵" },
  { to: "/psych-guard", label: "마음 상담" },
  { to: "/glossary", label: "용어집" },
];

export default function TopNav({ variant = "app" }: TopNavProps) {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    if (variant !== "app") return;

    supabase.auth.getUser().then(({ data }) => setUser(data.user));
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) =>
      setUser(session?.user ?? null),
    );
    return () => subscription.unsubscribe();
  }, [variant]);

  const displayName =
    (user?.user_metadata?.name as string | undefined)?.trim() ||
    user?.email?.split("@")[0] ||
    "회원";

  return (
    <header className="sticky top-0 z-50 hidden w-full shrink-0 border-b border-border bg-white/80 backdrop-blur-md lg:block">
      <div className="mx-auto flex w-full max-w-[1180px] items-center gap-7 px-8 py-[15px]">
        <Link
          to={variant === "app" ? "/home" : "/"}
          className="flex items-center"
        >
          <img src="/illustrations/logo.png" alt="ONZIP" className="h-[22px]" />
        </Link>

        {variant === "app" ? (
          <>
            <nav className="flex flex-1 items-center gap-1">
              {menuItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className="relative px-3.5 py-2 text-[15px] font-semibold text-text-gray whitespace-nowrap"
                >
                  {({ isActive }) => (
                    <>
                      <span className={isActive ? "text-text-dark" : ""}>
                        {item.label}
                      </span>
                      {isActive && (
                        <span className="absolute inset-x-3.5 -bottom-[17px] h-[2px] rounded-full bg-primary" />
                      )}
                    </>
                  )}
                </NavLink>
              ))}
            </nav>

            {user ? (
              <Link
                to="/profile"
                className="flex items-center gap-2 rounded-chip border border-border bg-subtle py-[5px] pl-3.5 pr-1.5 text-sm font-semibold text-text-gray whitespace-nowrap"
              >
                {displayName}
                <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-primary text-[13px] font-bold text-white">
                  {displayName.charAt(0).toUpperCase()}
                </span>
              </Link>
            ) : (
              <div className="flex flex-none items-center gap-2">
                <button
                  type="button"
                  onClick={() => navigate("/login")}
                  className="px-3.5 py-[9px] text-sm font-bold text-text-gray"
                >
                  로그인
                </button>
                <button
                  type="button"
                  onClick={() => navigate("/signup")}
                  className="rounded-btn bg-primary px-[18px] py-2.5 text-sm font-bold text-white"
                >
                  회원가입
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-1 items-center justify-end gap-2">
            <Link
              to="/login"
              className="px-3.5 py-[9px] text-sm font-bold text-text-gray"
            >
              로그인
            </Link>
            <Link
              to="/signup"
              className="rounded-btn bg-primary px-[18px] py-2.5 text-sm font-bold text-white"
            >
              회원가입
            </Link>
          </div>
        )}
      </div>
    </header>
  );
}
