export async function POST(request: Request) {
  const projectId = 'your project id';
  const teamID = 'your team id';
  const route = `${projectId}/pause?teamID=${teamID}`;

  await fetch(`https://api.vercel.com/v1/projects/${route}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
    },
  });

  return new Response('Project paused', { status: 200 });
}
