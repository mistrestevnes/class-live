// Pass this request to the class-live Worker (server folder), which holds everything.
export const onRequest = ({ request, env }) =>
  env.SERVER
    ? env.SERVER.fetch(request)
    : new Response(JSON.stringify({ error: "This site is not connected to the class-live server. See SETUP.txt." }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
