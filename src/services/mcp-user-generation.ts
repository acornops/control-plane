export type McpPrincipalWithGeneration = {
  type: 'user' | 'service_identity';
  id: string;
  membershipGeneration?: number;
};

export function mcpMembershipGeneration(
  ownerType: 'installation' | 'user',
  membershipGeneration: number | undefined
): number | undefined {
  if (ownerType === 'installation') {
    if (membershipGeneration !== undefined) {
      throw new Error('Workspace MCP connections must not carry a membership generation');
    }
    return undefined;
  }
  if (!Number.isSafeInteger(membershipGeneration) || membershipGeneration! <= 0) {
    throw new Error('Individual MCP operations require a positive safe membership generation');
  }
  return membershipGeneration;
}

export function gatewayMcpPrincipal(principal: McpPrincipalWithGeneration) {
  const membershipGeneration = mcpMembershipGeneration(
    principal.type === 'user' ? 'user' : 'installation',
    principal.membershipGeneration
  );
  return {
    type: principal.type,
    id: principal.id,
    ...(membershipGeneration !== undefined
      ? { membership_generation: membershipGeneration }
      : {})
  };
}
