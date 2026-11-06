-- Atualize o RPC no Supabase e remova os dados/tabela do histórico de lotes.
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

drop table if exists public.historico_lotes_racao;
