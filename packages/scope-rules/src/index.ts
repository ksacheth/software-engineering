export {
  classifyAddress,
  classifyResolvedAddresses,
  isForbiddenAddress,
  CLOUD_METADATA_IPV4,
  CLOUD_METADATA_IPV6,
  type AddressVerdict,
  type AddressRefusalReason,
} from './address.js';

export {
  isWithinVerifiedSet,
  toVerifiedIpRanges,
  type VerifiedSetVerdict,
  type VerifiedSetRefusalReason,
} from './verified-set.js';
