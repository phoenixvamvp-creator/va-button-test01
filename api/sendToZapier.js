// /api/sendToZapier.js
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  const zapierWebhook = "https://hooks.zapier.com/hooks/catch/123456/abcdef"; // replace with your Zapier webhook

  try {
    const response = await fetch(zapierWebhook, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body), // Forward the VA payload
    });

    const data = await response.text();
    return res.status(200).json({ message: "Sent to Zapier", data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error sending to Zapier", error });
  }
}
