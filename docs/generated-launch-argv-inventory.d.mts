export declare const GENERATED_LAUNCH_ARGV_INVENTORY_VERSION: string;

export declare function materializeGeneratedLaunchArgvInventory(repoRoot: string): {
  generated: boolean;
  inventory: any;
};

export declare function loadCommittedLaunchArgvBundle(repoRoot: string): any;

export declare function auditCommittedLaunchArgvInventory(repoRoot: string): any;
