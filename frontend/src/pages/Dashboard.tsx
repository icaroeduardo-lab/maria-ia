import { useQuery } from "@tanstack/react-query";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { api } from "../lib/api";

interface Summary {
  total: number;
  taxaConclusao: number;
  porStatus: { status: string; total: number }[];
  porCategoria: { categoria: string; total: number }[];
  porCanal: { canal: string; total: number }[];
  abandonoPorEtapa: { etapa: string; total: number }[];
  serieDiaria: { dia: string; total: number; concluidas: number }[];
}

function Card({ titulo, valor }: { titulo: string; valor: string | number }) {
  return (
    <div className="bg-white rounded-xl shadow p-5">
      <p className="text-sm text-slate-500">{titulo}</p>
      <p className="text-3xl font-bold text-emerald-800">{valor}</p>
    </div>
  );
}

function Painel({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl shadow p-5">
      <h2 className="font-semibold mb-3">{titulo}</h2>
      <div className="h-64">{children}</div>
    </div>
  );
}

export function Dashboard() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["summary"],
    queryFn: () => api<Summary>("/admin/analytics/summary"),
  });

  if (isLoading) return <p>Carregando…</p>;
  if (error || !data) return <p className="text-red-600">Erro: {String(error)}</p>;

  const status = (s: string) => data.porStatus.find((x) => x.status === s)?.total ?? 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card titulo="Conversas" valor={data.total} />
        <Card titulo="Taxa de conclusão" valor={`${Math.round(data.taxaConclusao * 100)}%`} />
        <Card titulo="Concluídas" valor={status("completed")} />
        <Card titulo="Ativas" valor={status("active")} />
        <Card titulo="Abandonadas" valor={status("abandoned")} />
      </div>
      <div className="grid md:grid-cols-2 gap-6">
        <Painel titulo="Conversas por dia (30 dias)">
          <ResponsiveContainer>
            <LineChart data={data.serieDiaria}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="dia" fontSize={11} />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Line dataKey="total" name="Total" stroke="#047857" strokeWidth={2} />
              <Line dataKey="concluidas" name="Concluídas" stroke="#0ea5e9" strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </Painel>
        <Painel titulo="Por categoria">
          <ResponsiveContainer>
            <BarChart data={data.porCategoria}>
              <XAxis dataKey="categoria" fontSize={11} />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="total" fill="#047857" />
            </BarChart>
          </ResponsiveContainer>
        </Painel>
        <Painel titulo="Abandono por etapa">
          <ResponsiveContainer>
            <BarChart data={data.abandonoPorEtapa}>
              <XAxis dataKey="etapa" fontSize={11} />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="total" fill="#dc2626" />
            </BarChart>
          </ResponsiveContainer>
        </Painel>
        <Painel titulo="Por canal">
          <ResponsiveContainer>
            <BarChart data={data.porCanal}>
              <XAxis dataKey="canal" fontSize={11} />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="total" fill="#0ea5e9" />
            </BarChart>
          </ResponsiveContainer>
        </Painel>
      </div>
    </div>
  );
}
