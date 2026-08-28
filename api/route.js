const OSRM_BASE_URL = 'https://router.project-osrm.org/route/v1/driving/';

export default async function handler(request, response) {
  const { coordinates, alternatives = 'false' } = request.query;

  if (typeof coordinates !== 'string' || !/^[-\d.,;]+$/.test(coordinates)) {
    return response.status(400).json({ error: 'Coordenadas invalidas.' });
  }

  const points = coordinates.split(';');
  if (points.length < 2 || points.some((point) => point.split(',').length !== 2)) {
    return response.status(400).json({ error: 'Informe pelo menos dois pontos validos.' });
  }

  const url = new URL(coordinates, OSRM_BASE_URL);
  url.searchParams.set('overview', 'full');
  url.searchParams.set('geometries', 'geojson');
  url.searchParams.set('alternatives', alternatives === 'true' ? 'true' : 'false');

  try {
    const upstreamResponse = await fetch(url);
    const data = await upstreamResponse.json();
    return response.status(upstreamResponse.status).json(data);
  } catch (error) {
    console.error('Erro ao consultar o OSRM:', error);
    return response.status(502).json({ error: 'Servico de rotas indisponivel.' });
  }
}
