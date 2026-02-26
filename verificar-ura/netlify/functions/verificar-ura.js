// =============================================================
// VERIFICAR URA - Primem Comex - v2
// =============================================================

exports.handler = async (event) => {
  const BITRIX_WEBHOOK = "https://primem.bitrix24.com.br/rest/89/9kjhemihvx0oz752";
  const CAMPO_URA = "UF_CRM_1772056801";

  console.log("=== VERIFICAR URA v2 - INÍCIO ===");

  try {
    // 1. EXTRAIR DEAL ID
    let dealId;
    if (event.queryStringParameters?.dealId) {
      dealId = event.queryStringParameters.dealId;
    } else if (event.body) {
      const params = new URLSearchParams(event.body);
      dealId = params.get("dealId") || params.get("document_id");
    }

    if (!dealId) {
      return { statusCode: 400, body: JSON.stringify({ error: "dealId não encontrado" }) };
    }

    console.log("Deal ID:", dealId);

    // 2. BUSCAR DADOS DO NEGÓCIO
    const dealRes = await fetch(`${BITRIX_WEBHOOK}/crm.deal.get?id=${dealId}`);
    const dealData = await dealRes.json();
    const title = dealData.result?.TITLE || "";
    const dateCreate = dealData.result?.DATE_CREATE || "";

    console.log("Título:", title);
    console.log("Data criação:", dateCreate);

    // Extrair telefone do título
    const phoneMatch = title.match(/- (.+?) - Chamada/);
    if (!phoneMatch) {
      console.log("Telefone não encontrado no título");
      const updateResult = await updateDeal(BITRIX_WEBHOOK, dealId, CAMPO_URA, "Não");
      return {
        statusCode: 200,
        body: JSON.stringify({ status: "phone_not_found", dealId, passouURA: "Não", updateResult }),
      };
    }

    const phone = phoneMatch[1].trim();
    const phoneDigits = phone.replace(/\D/g, "");
    console.log("Telefone:", phone, "Dígitos:", phoneDigits);

    // 3. BUSCAR ATIVIDADES NO SPA 655
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    const spaUrl = `${BITRIX_WEBHOOK}/crm.activity.list?filter[OWNER_TYPE_ID]=14&filter[OWNER_ID]=655&filter[PROVIDER_ID]=VOXIMPLANT_CALL&filter[>CREATED]=${encodeURIComponent(twoHoursAgo)}&order[ID]=DESC&select[]=ID&select[]=SETTINGS&select[]=SUBJECT&select[]=START_TIME`;

    console.log("Buscando atividades no SPA...");
    const spaRes = await fetch(spaUrl);
    const spaData = await spaRes.json();

    const activities = spaData.result || [];
    console.log("Atividades encontradas:", activities.length);

    // 4. ENCONTRAR ATIVIDADE DO TELEFONE
    let passouURA = "Não";

    const matching = activities.find((act) => {
      const subjectDigits = (act.SUBJECT || "").replace(/\D/g, "");
      return subjectDigits.includes(phoneDigits);
    });

    if (matching) {
      console.log("Atividade encontrada:", matching.ID, "SETTINGS:", JSON.stringify(matching.SETTINGS));
      if (matching.SETTINGS?.MISSED_CALL === true) {
        passouURA = "Sim";
      }
    } else {
      console.log("Nenhuma atividade correspondente encontrada");
    }

    console.log("Resultado: passouURA =", passouURA);

    // 5. ATUALIZAR CAMPO NO NEGÓCIO
    const updateResult = await updateDeal(BITRIX_WEBHOOK, dealId, CAMPO_URA, passouURA);

    console.log("=== VERIFICAR URA v2 - FIM ===");

    return {
      statusCode: 200,
      body: JSON.stringify({
        status: "ok",
        dealId,
        phone,
        passouURA,
        activityFound: matching?.ID || null,
        updateResult,
      }),
    };
  } catch (error) {
    console.error("ERRO:", error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};

// ATUALIZAR CAMPO NO NEGÓCIO
async function updateDeal(webhookUrl, dealId, fieldCode, value) {
  const enumValue = value === "Sim" ? "1687" : "1689";
  const url = `${webhookUrl}/crm.deal.update?id=${dealId}&fields[${fieldCode}]=${enumValue}`;
  console.log("Update URL:", url);
  try {
    const res = await fetch(url);
    const data = await res.json();
    console.log("Update response:", JSON.stringify(data));
    return data;
  } catch (err) {
    console.error("Update error:", err.message);
    return { error: err.message };
  }
}
