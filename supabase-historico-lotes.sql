create table if not exists public.historico_lotes_racao (
  id bigint generated always as identity primary key,
  integrado_nome text not null,
  cidade text not null,
  animais_alojados integer not null default 0,
  galpoes jsonb not null default '[]'::jsonb,
  pedidos jsonb not null default '[]'::jsonb,
  fases_racao jsonb not null default '[]'::jsonb,
  concluido_em timestamptz not null default now()
);

create index if not exists historico_lotes_racao_concluido_em_idx
  on public.historico_lotes_racao (concluido_em desc);

alter table public.historico_lotes_racao enable row level security;

drop policy if exists historico_lotes_racao_authenticated_read
  on public.historico_lotes_racao;
create policy historico_lotes_racao_authenticated_read
  on public.historico_lotes_racao
  for select
  to authenticated
  using (true);

grant select on public.historico_lotes_racao to authenticated;

create or replace function public.iniciar_novo_lote_racao(
  p_integrado_nome text,
  p_animais_alojados integer,
  p_galpoes jsonb,
  p_fases_racao jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_integrado public.integrados%rowtype;
  v_tem_lote_ativo boolean;
begin
  if auth.role() is distinct from 'authenticated' then
    raise exception 'Autenticação necessária para iniciar um lote.';
  end if;

  if p_animais_alojados is null or p_animais_alojados < 0 then
    raise exception 'A quantidade de animais deve ser igual ou maior que zero.';
  end if;

  if jsonb_typeof(coalesce(p_galpoes, '[]'::jsonb)) <> 'array' then
    raise exception 'A lista de galpões deve ser um array JSON.';
  end if;

  select *
  into v_integrado
  from public.integrados
  where nome = p_integrado_nome
  for update;

  if not found then
    raise exception 'Integrado não encontrado: %.', p_integrado_nome;
  end if;

  select coalesce(v_integrado.animais_alojados, 0) > 0
    or exists (
      select 1 from public.galpoes_racao
      where integrado_nome = p_integrado_nome
    )
    or exists (
      select 1 from public.pedidos_racao
      where integrado_nome = p_integrado_nome
    )
  into v_tem_lote_ativo;

  if v_tem_lote_ativo then
    insert into public.historico_lotes_racao (
      integrado_nome,
      cidade,
      animais_alojados,
      galpoes,
      pedidos,
      fases_racao
    )
    values (
      v_integrado.nome,
      v_integrado.cidade,
      coalesce(v_integrado.animais_alojados, 0),
      coalesce((
        select jsonb_agg(to_jsonb(g) order by g.nome_galpao)
        from public.galpoes_racao as g
        where g.integrado_nome = p_integrado_nome
      ), '[]'::jsonb),
      coalesce((
        select jsonb_agg(to_jsonb(p) order by p.data_entrega, p.id)
        from public.pedidos_racao as p
        where p.integrado_nome = p_integrado_nome
      ), '[]'::jsonb),
      coalesce(p_fases_racao, '[]'::jsonb)
    );
  end if;

  delete from public.pedidos_racao
  where integrado_nome = p_integrado_nome;

  delete from public.galpoes_racao
  where integrado_nome = p_integrado_nome;

  insert into public.galpoes_racao (integrado_nome, nome_galpao, animais_alojados)
  select
    p_integrado_nome,
    btrim(galpao->>'nome_galpao'),
    coalesce((galpao->>'animais_alojados')::integer, 0)
  from jsonb_array_elements(coalesce(p_galpoes, '[]'::jsonb)) as item(galpao)
  where nullif(btrim(galpao->>'nome_galpao'), '') is not null;

  update public.integrados
  set animais_alojados = p_animais_alojados
  where nome = p_integrado_nome;
end;
$$;

revoke all on function public.iniciar_novo_lote_racao(text, integer, jsonb, jsonb) from public;
grant execute on function public.iniciar_novo_lote_racao(text, integer, jsonb, jsonb) to authenticated;