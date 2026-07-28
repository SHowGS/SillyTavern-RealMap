export const PLUGIN_LLM_MAX_TOKENS = 65_536;

function extractText(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        return value
            .map(extractText)
            .filter(Boolean)
            .join('\n');
    }
    if (!value || typeof value !== 'object') return '';
    if (typeof value.text === 'string') return value.text;
    if (typeof value.text?.value === 'string') return value.text.value;
    if (typeof value.output_text === 'string') return value.output_text;
    if (typeof value.value === 'string') return value.value;
    if (value.content !== undefined) return extractText(value.content);
    return '';
}

function getOutputText(data) {
    if (typeof data?.output_text === 'string') return data.output_text;
    if (!Array.isArray(data?.output)) return '';
    return data.output
        .flatMap(item => Array.isArray(item?.content) ? item.content : [item])
        .map(extractText)
        .filter(Boolean)
        .join('\n');
}

function getApiError(data) {
    const error = data?.error;
    if (typeof error === 'string') return error;
    if (typeof error?.message === 'string') return error.message;
    if (typeof data?.message === 'string' && !Array.isArray(data?.choices)) {
        return data.message;
    }
    return '';
}

export function parseLlmResponsePayload(data) {
    const choice = data?.choices?.[0];
    const message = choice?.message;
    const candidates = [
        ['choices[0].message.content', extractText(message?.content)],
        ['choices[0].text', extractText(choice?.text)],
        ['output_text', extractText(data?.output_text)],
        ['output[].content', getOutputText(data)],
        ['choices[0].message.reasoning_content', extractText(message?.reasoning_content)],
        ['choices[0].message.reasoning', extractText(message?.reasoning)],
    ];
    const selected = candidates.find(([, text]) => Boolean(String(text ?? '').trim()));
    return {
        rawContent: selected ? String(selected[1]) : '',
        contentSource: selected?.[0] || '',
        reasoningContent: extractText(message?.reasoning_content ?? message?.reasoning),
        finishReason: String(choice?.finish_reason ?? data?.status ?? ''),
        model: String(data?.model ?? ''),
        usage: data?.usage && typeof data.usage === 'object' ? data.usage : null,
        apiError: getApiError(data),
    };
}

export function stringifyLlmResponse(value, maxChars = 20_000) {
    let text;
    try {
        text = JSON.stringify(value, null, 2);
    } catch (_) {
        text = String(value ?? '');
    }
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n…响应过长，已截断`;
}

export function combineLlmDebugReports(...reports) {
    return reports
        .flat()
        .map(report => String(report ?? '').trim())
        .filter(Boolean)
        .join('\n\n');
}

export function extractJsonObject(text, preferredKey = 'action') {
    const source = String(text ?? '');
    const matches = [];
    for (let start = 0; start < source.length; start += 1) {
        if (source[start] !== '{') continue;
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let index = start; index < source.length; index += 1) {
            const char = source[index];
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (char === '\\') {
                    escaped = true;
                } else if (char === '"') {
                    inString = false;
                }
                continue;
            }
            if (char === '"') {
                inString = true;
                continue;
            }
            if (char === '{') {
                depth += 1;
                continue;
            }
            if (char !== '}') continue;
            depth -= 1;
            if (depth !== 0) continue;

            const jsonText = source.slice(start, index + 1);
            try {
                const value = JSON.parse(jsonText);
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    matches.push({ text: jsonText, value });
                    start = index;
                }
            } catch (_) {
                // 从下一个左花括号继续寻找完整JSON对象。
            }
            break;
        }
    }
    if (!matches.length) return null;
    const preferred = matches.filter(match => Object.prototype.hasOwnProperty.call(
        match.value,
        preferredKey,
    ));
    return (preferred.length ? preferred : matches).at(-1);
}
