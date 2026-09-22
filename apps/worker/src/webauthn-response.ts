import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { PasskeyAuthenticationResponse, PasskeyRegistrationResponse } from "@renewlet/shared/schemas/auth";

type PasskeyClientExtensionResults = PasskeyRegistrationResponse["clientExtensionResults"];

function clientExtensionResultsForVerification(value: PasskeyClientExtensionResults): RegistrationResponseJSON["clientExtensionResults"] {
  const result: RegistrationResponseJSON["clientExtensionResults"] = {};
  if (typeof value.appid === "boolean") result.appid = value.appid;
  if (typeof value.hmacCreateSecret === "boolean") result.hmacCreateSecret = value.hmacCreateSecret;
  if (value.credProps) {
    const credProps: NonNullable<RegistrationResponseJSON["clientExtensionResults"]["credProps"]> = {};
    if (typeof value.credProps.rk === "boolean") credProps.rk = value.credProps.rk;
    result.credProps = credProps;
  }
  return result;
}

// shared schema 是浏览器响应边界，SimpleWebAuthn 类型是校验器边界；显式拷贝可阻止两侧可选字段静默漂移。
export function registrationResponseForVerification(response: PasskeyRegistrationResponse): RegistrationResponseJSON {
  const authenticatorResponse: RegistrationResponseJSON["response"] = {
    clientDataJSON: response.response.clientDataJSON,
    attestationObject: response.response.attestationObject,
  };
  if (response.response.authenticatorData) authenticatorResponse.authenticatorData = response.response.authenticatorData;
  if (response.response.transports) authenticatorResponse.transports = [...response.response.transports];
  if (typeof response.response.publicKeyAlgorithm === "number") {
    authenticatorResponse.publicKeyAlgorithm = response.response.publicKeyAlgorithm;
  }
  if (response.response.publicKey) authenticatorResponse.publicKey = response.response.publicKey;

  const result: RegistrationResponseJSON = {
    id: response.id,
    rawId: response.rawId,
    response: authenticatorResponse,
    clientExtensionResults: clientExtensionResultsForVerification(response.clientExtensionResults),
    type: response.type,
  };
  if (response.authenticatorAttachment) result.authenticatorAttachment = response.authenticatorAttachment;
  return result;
}

export function authenticationResponseForVerification(response: PasskeyAuthenticationResponse): AuthenticationResponseJSON {
  const authenticatorResponse: AuthenticationResponseJSON["response"] = {
    clientDataJSON: response.response.clientDataJSON,
    authenticatorData: response.response.authenticatorData,
    signature: response.response.signature,
  };
  if (response.response.userHandle) authenticatorResponse.userHandle = response.response.userHandle;

  const result: AuthenticationResponseJSON = {
    id: response.id,
    rawId: response.rawId,
    response: authenticatorResponse,
    clientExtensionResults: clientExtensionResultsForVerification(response.clientExtensionResults),
    type: response.type,
  };
  if (response.authenticatorAttachment) result.authenticatorAttachment = response.authenticatorAttachment;
  return result;
}
