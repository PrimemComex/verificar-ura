// verificar-ura.js - v4
// Verifica se o cliente interagiu com a URA analisando o CALL_LOG do Voximplant
// Busca por evento "Call.ToneReceived" (pressionamento de tecla DTMF)
// 
// HISTÓRICO:
// v1 - Matching por primeiro resultado
// v2 - URL hardcoded, método GET para atualização
// v3 - Matching por horário mais próximo
// v4 - Análise do CALL_LOG do Voximplant para detectar DTMF (resolve spam com MISSED_CALL:true)

const BITRIX_WEBHOOK = "https://primem.bitrix24.com.br/rest/89/9kjhemihvx0oz752";

exports.handler = async (event) => {
  try {
    // 1. Receber o dealId
    let dealId = null;

    // Tenta pegar do query string (GET)
    if (event.queryStringParameters && event.queryStringParameters.dealId) {
      dealId = event.queryStringParameters.dealId;
    }

    // Tenta pegar do body (POST)
    if (!dealId && event.body) {
      try {
        const body = JSON.parse(event.body);
        dealId = body.dealId || body.DEAL_ID || body.deal_id;
      } catch (e) {
        // Body pode ser form-encoded
        const params = new URLSearchParams(event.body);
        dealId = params.get("dealId") || params.get("DEAL_ID");
      }
    }

    if (!dealId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "dealId não fornecido" }),
      };
    }

    console.log(`[v4] Processando deal: ${dealId}`);

    // 2. Buscar dados do negócio
    const dealRes = await fetch(`${BITRIX_WEBHOOK}/crm.deal.get?id=${dealId}`);
    const dealData = await dealRes.json();

    if (!dealData.result) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Negócio não encontrado", dealId }),
      };
    }

    const dealTitle = dealData.result.TITLE;
    const dealCreated = dealData.result.DATE_CREATE;
    console.log(`[v4] Título: ${dealTitle}`);
    console.log(`[v4] Criado em: ${dealCreated}`);

    // 3. Extrair telefone do título
    const phoneMatch = dealTitle.match(/- (.+?) - Chamada/);
    if (!phoneMatch) {
      console.log(`[v4] Não foi possível extrair telefone do título`);
      return {
        statusCode: 200,
        body: JSON.stringify({
          status: "error",
          dealId,
          message: "Telefone não encontrado no título",
        }),
      };
    }

    const phone = phoneMatch[1].trim();
    const phoneDigits = phone.replace(/\D/g, "");
    console.log(`[v4] Telefone: ${phone} (dígitos: ${phoneDigits})`);

    // 4. Buscar atividades de chamada no SPA 655 (últimas 2 horas)
    const dealDate = new Date(dealCreated);
    const searchFrom = new Date(dealDate.getTime() - 2 * 60 * 60 * 1000);
    const searchFromISO = searchFrom.toISOString();

    const actUrl =
      `${BITRIX_WEBHOOK}/crm.activity.list` +
      `?filter[OWNER_TYPE_ID]=14` +
      `&filter[OWNER_ID]=655` +
      `&filter[PROVIDER_ID]=VOXIMPLANT_CALL` +
      `&filter[>CREATED]=${searchFromISO}` +
      `&order[ID]=DESC` +
      `&select[]=ID&select[]=SETTINGS&select[]=SUBJECT` +
      `&select[]=START_TIME&select[]=CREATED&select[]=ORIGIN_ID`;

    const actRes = await fetch(actUrl);
    const actData = await actRes.json();

    console.log(`[v4] Atividades encontradas: ${actData.result ? actData.result.length : 0}`);

    if (!actData.result || actData.result.length === 0) {
      // Nenhuma atividade encontrada — marca como "Não" (seguro)
      await atualizarCampo(dealId, "1689");
      return {
        statusCode: 200,
        body: JSON.stringify({
          status: "ok",
          dealId,
          passouURA: "Não",
          motivo: "Nenhuma atividade encontrada",
        }),
      };
    }

    // 5. Filtrar pelo número de telefone e encontrar a mais próxima
    const dealTime = dealDate.getTime();
    let closestActivity = null;
    let closestDiff = Infinity;

    for (const act of actData.result) {
      // Comparar telefone (por dígitos)
      const actPhone = (act.SUBJECT || "").replace(/\D/g, "");
      if (!actPhone.includes(phoneDigits.slice(-8))) {
        continue; // Telefone diferente
      }

      // Calcular diferença de tempo com a criação do negócio
      const actTime = new Date(act.CREATED).getTime();
      const diff = Math.abs(dealTime - actTime);

      if (diff < closestDiff) {
        closestDiff = diff;
        closestActivity = act;
      }
    }

    if (!closestActivity) {
      console.log(`[v4] Nenhuma atividade correspondente ao telefone`);
      await atualizarCampo(dealId, "1689");
      return {
        statusCode: 200,
        body: JSON.stringify({
          status: "ok",
          dealId,
          phone,
          passouURA: "Não",
          motivo: "Nenhuma atividade correspondente ao telefone",
        }),
      };
    }

    console.log(`[v4] Atividade selecionada: ${closestActivity.ID}`);
    console.log(`[v4] ORIGIN_ID: ${closestActivity.ORIGIN_ID}`);
    console.log(`[v4] Criada em: ${closestActivity.CREATED}`);

    // 6. Extrair CALL_ID do ORIGIN_ID (remover prefixo "VI_")
    const originId = closestActivity.ORIGIN_ID || "";
    const callId = originId.startsWith("VI_") ? originId.substring(3) : originId;

    if (!callId) {
      console.log(`[v4] ORIGIN_ID vazio — impossível buscar CALL_LOG`);
      // Fallback: usa MISSED_CALL como antes
      const missedCall = closestActivity.SETTINGS && closestActivity.SETTINGS.MISSED_CALL;
      const resultado = missedCall ? "1687" : "1689";
      await atualizarCampo(dealId, resultado);
      return {
        statusCode: 200,
        body: JSON.stringify({
          status: "ok",
          dealId,
          phone,
          passouURA: missedCall ? "Sim (fallback MISSED_CALL)" : "Não",
          motivo: "ORIGIN_ID vazio, usado fallback MISSED_CALL",
        }),
      };
    }

    console.log(`[v4] CALL_ID: ${callId}`);

    // 7. Buscar estatísticas da chamada no Voximplant
    const voxUrl = `${BITRIX_WEBHOOK}/voximplant.statistic.get?FILTER[CALL_ID]=${callId}`;
    const voxRes = await fetch(voxUrl);
    const voxData = await voxRes.json();

    console.log(`[v4] Voximplant resultados: ${voxData.result ? voxData.result.length : 0}`);

    if (!voxData.result || voxData.result.length === 0) {
      console.log(`[v4] Chamada não encontrada no Voximplant — marca como Não`);
      await atualizarCampo(dealId, "1689");
      return {
        statusCode: 200,
        body: JSON.stringify({
          status: "ok",
          dealId,
          phone,
          callId,
          passouURA: "Não",
          motivo: "Chamada não encontrada no voximplant.statistic.get",
        }),
      };
    }

    const callStat = voxData.result[0];
    const callLogUrl = callStat.CALL_LOG;

    if (!callLogUrl) {
      console.log(`[v4] CALL_LOG vazio — marca como Não`);
      await atualizarCampo(dealId, "1689");
      return {
        statusCode: 200,
        body: JSON.stringify({
          status: "ok",
          dealId,
          phone,
          callId,
          passouURA: "Não",
          motivo: "CALL_LOG URL vazio",
        }),
      };
    }

    console.log(`[v4] CALL_LOG URL obtida, buscando conteúdo...`);

    // 8. Fazer fetch do CALL_LOG e procurar por "Call.ToneReceived"
    const logRes = await fetch(callLogUrl);
    const logText = await logRes.text();

    console.log(`[v4] CALL_LOG tamanho: ${logText.length} caracteres`);

    const toneReceived = logText.includes("Call.ToneReceived");

    console.log(`[v4] Call.ToneReceived encontrado: ${toneReceived}`);

    // 9. Atualizar campo no negócio
    const enumId = toneReceived ? "1687" : "1689"; // 1687=Sim, 1689=Não
    const updateResult = await atualizarCampo(dealId, enumId);

    const resultado = {
      status: "ok",
      dealId,
      phone,
      callId,
      activityId: closestActivity.ID,
      activityCreated: closestActivity.CREATED,
      dealCreated,
      callDuration: callStat.CALL_DURATION,
      toneReceived,
      passouURA: toneReceived ? "Sim" : "Não",
      updateResult,
    };

    console.log(`[v4] Resultado:`, JSON.stringify(resultado));

    return {
      statusCode: 200,
      body: JSON.stringify(resultado),
    };
  } catch (error) {
    console.error(`[v4] Erro:`, error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

// Função auxiliar para atualizar o campo "Passou pela URA" no negócio
async function atualizarCampo(dealId, enumId) {
  const url = `${BITRIX_WEBHOOK}/crm.deal.update?id=${dealId}&fields[UF_CRM_1772056801]=${enumId}`;
  const res = await fetch(url);
  const data = await res.json();
  console.log(`[v4] Campo atualizado: dealId=${dealId}, valor=${enumId === "1687" ? "Sim" : "Não"}, resultado=${JSON.stringify(data)}`);
  return data;
}
