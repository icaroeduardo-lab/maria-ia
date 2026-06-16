import { createRootRoute, createRoute, createRouter, redirect, Outlet, Link, useNavigate } from "@tanstack/react-router";
import { useAuth } from "./store";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Flows } from "./pages/Flows";
import { Builder } from "./pages/Builder";
import { Conversations } from "./pages/Conversations";
import { Organizacao } from "./pages/Organizacao";
import { TestChat } from "./pages/TestChat";

function Layout() {
  const { usuario, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="min-h-screen">
      <header className="bg-emerald-800 text-white px-6 py-3 flex items-center gap-6">
        <span className="font-bold text-lg">Maria Chat — Admin</span>
        <nav className="flex gap-4 text-sm">
          <Link to="/" className="hover:underline [&.active]:font-bold">Dashboard</Link>
          <Link to="/flows" className="hover:underline [&.active]:font-bold">Fluxos</Link>
          <Link to="/conversations" className="hover:underline [&.active]:font-bold">Conversas</Link>
          <Link to="/org" className="hover:underline [&.active]:font-bold">Organização</Link>
          <Link to="/test-chat" className="hover:underline [&.active]:font-bold">Testar Fluxo</Link>
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <span>{usuario?.nome || usuario?.email}</span>
          <button
            className="bg-emerald-900 px-3 py-1 rounded hover:bg-emerald-950"
            onClick={() => { logout(); navigate({ to: "/login" }); }}
          >
            Sair
          </button>
        </div>
      </header>
      <main className="p-6">
        <Outlet />
      </main>
    </div>
  );
}

const rootRoute = createRootRoute();

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: Login,
});

const protectedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "protected",
  beforeLoad: () => {
    if (!useAuth.getState().token) throw redirect({ to: "/login" });
  },
  component: Layout,
});

const dashboardRoute = createRoute({ getParentRoute: () => protectedRoute, path: "/", component: Dashboard });
const flowsRoute = createRoute({ getParentRoute: () => protectedRoute, path: "/flows", component: Flows });
const builderRoute = createRoute({ getParentRoute: () => protectedRoute, path: "/flows/$flowId", component: Builder });
const conversationsRoute = createRoute({ getParentRoute: () => protectedRoute, path: "/conversations", component: Conversations });
const orgRoute = createRoute({ getParentRoute: () => protectedRoute, path: "/org", component: Organizacao });
const testChatRoute = createRoute({ getParentRoute: () => protectedRoute, path: "/test-chat", component: TestChat });

const routeTree = rootRoute.addChildren([
  loginRoute,
  protectedRoute.addChildren([dashboardRoute, flowsRoute, builderRoute, conversationsRoute, orgRoute, testChatRoute]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
