// =============================================================
// VERIFICAR URA - Primem Comex
// Verifica se o cliente interagiu com a URA antes de desligar
// =============================================================

exports.handler = async (event) => {
  const BITRIX_WEBHOOK = process.env.BITRIX_WEBHOOK_URL;

  // Log inicial
  console.log("=== VERIFICAR URA - INÍCIO ===");
  console.log("Método:", event.httpMethod);

  try {
    // ----------------------------------------------------------
    // 1. EXTRAIR O ID DO NEGÓCIO
    // ----------------------------------------------------------
    let dealId;

    if (event.queryStringParameters?.dealId) {
      dealId = event.queryStringParameters.dealId;
    } else if (event.body) {
      const params = new URLSearchParams(event.body);
      dealId = params.get("dealId") || params.get("document_id");
    }

    if (!dealId) {
      console.log("ERRO: dealId não encontrado");
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "dealId não encontrado" }),
      };
    }

    console.log("Deal ID:", dealId);

    // ----------------------------------------------------------
    // 2. BUSCAR DADOS DO NEGÓCIO (para extrair o telefone)
    // ----------------------------------------------------------
    const dealRes = await fetch(
      `${BITRIX_WEBHOOK}/crm.deal.get?id=${dealId}`
    );
    const dealData = await dealRes.json();
    const title = dealData.result?.TITLE || "";

    console.log("Título do negócio:", title);

    // Extrair telefone do título
    // Formato: "ID15993 - +55 21 97637-4845 - Chamada recebida"
    const phoneMatch = title.match(/- (.+?) - Chamada/);

    if (!phoneMatch) {
      console.log("ERRO: Telefone não encontrado no título");
      await updateDealField(BITRIX_WEBHOOK, dealId, "Não");
      return {
        statusCode: 200,
        body: JSON.stringify({
          status: "phone_not_found",
          dealId,
          passouURA: "Não",
        }),
      };
    }

    const phone = phoneMatch[1].trim();
    console.log("Telefone extraído:", phone);

    // ----------------------------------------------------------
    // 3. BUSCAR ATIVIDADE DE CHAMADA NO NEGÓCIO
    // ----------------------------------------------------------
    let missedCall = null;

    const dealActRes = await fetch(
      `${BITRIX_WEBHOOK}/crm.activity.list` +
        `?filter[OWNER_TYPE_ID]=2` +
        `&filter[OWNER_ID]=${dealId}` +
        `&filter[PROVIDER_ID]=VOXIMPLANT_CALL` +
        `&order[ID]=DESC` +
        `&select[]=ID&select[]=SETTINGS&select[]=SUBJECT`
    );
    const dealActData = await dealActRes.json();

    if (dealActData.result && dealActData.result.length > 0) {
      missedCall = dealActData.result[0].SETTINGS?.MISSED_CALL === true;
      console.log("Atividade encontrada no NEGÓCIO. MISSED_CALL:", missedCall);
    } else {
      console.log("Nenhuma atividade de chamada no negócio.");
    }

    // ----------------------------------------------------------
    // 4. SE NÃO ACHOU NO NEGÓCIO, BUSCAR NO SPA 655
    // ----------------------------------------------------------
    if (missedCall === null) {
      console.log("Buscando atividade no SPA 655...");

      // Buscar atividades recentes do SPA (últimas 2 horas)
      const twoHoursAgo = new Date(
        Date.now() - 2 * 60 * 60 * 1000
      ).toISOString();

      const spaActRes = await fetch(
        `${BITRIX_WEBHOOK}/crm.activity.list` +
          `?filter[OWNER_TYPE_ID]=14` +
          `&filter[OWNER_ID]=655` +
          `&filter[PROVIDER_ID]=VOXIMPLANT_CALL` +
          `&filter[>CREATED]=${encodeURIComponent(twoHoursAgo)}` +
          `&order[ID]=DESC` +
          `&select[]=ID&select[]=SETTINGS&select[]=SUBJECT&select[]=START_TIME`
      );
      const spaActData = await spaActRes.json();

      console.log(
        "Atividades no SPA encontradas:",
        spaActData.result?.length || 0
      );

      // Encontrar atividade que corresponde ao telefone
      if (spaActData.result && spaActData.result.length > 0) {
        // Limpar o telefone para comparação (só números)
        const phoneDigits = phone.replace(/\D/g, "");

        const matchingActivity = spaActData.result.find((act) => {
          const subjectDigits = (act.SUBJECT || "").replace(/\D/g, "");
          return subjectDigits.includes(phoneDigits);
        });

        if (matchingActivity) {
          missedCall = matchingActivity.SETTINGS?.MISSED_CALL === true;
          console.log(
            "Atividade encontrada no SPA. ID:",
            matchingActivity.ID,
            "MISSED_CALL:",
            missedCall
          );
        } else {
          console.log(
            "Nenhuma atividade correspondente ao telefone no SPA."
          );
        }
      }
    }

    // ----------------------------------------------------------
    // 5. DETERMINAR RESULTADO E ATUALIZAR NEGÓCIO
    // ----------------------------------------------------------
    // MISSED_CALL: true  → Cliente selecionou opção na URA → "Sim"
    // Sem MISSED_CALL    → Cliente desligou na URA         → "Não"
    const passouURA = missedCall === true ? "Sim" : "Não";

    console.log("Resultado: Passou pela URA =", passouURA);

    await updateDealField(BITRIX_WEBHOOK, dealId, passouURA);

    console.log("=== VERIFICAR URA - FIM ===");

    return {
      statusCode: 200,
      body: JSON.stringify({ status: "ok", dealId, phone, passouURA }),
    };
  } catch (error) {
    console.error("ERRO:", error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

// ----------------------------------------------------------
// FUNÇÃO AUXILIAR: Atualizar campo "Passou pela URA" no negócio
// ----------------------------------------------------------
async function updateDealField(webhookUrl, dealId, value) {
  const res = await fetch(`${webhookUrl}/crm.deal.update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: dealId,
      fields: {
        UF_CRM_1772056801: value,
      },
    }),
  });
  const data = await res.json();
  console.log("Atualização do negócio:", data.result ? "OK" : "FALHOU");
  return data;
}
