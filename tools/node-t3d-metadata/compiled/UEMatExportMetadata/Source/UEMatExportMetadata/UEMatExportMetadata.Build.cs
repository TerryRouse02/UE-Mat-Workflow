using UnrealBuildTool;

public class UEMatExportMetadata : ModuleRules
{
    public UEMatExportMetadata(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        PublicDependencyModuleNames.AddRange(new[]
        {
            "Core",
            "CoreUObject",
            "Engine"
        });

        PrivateDependencyModuleNames.AddRange(new[]
        {
            "AssetRegistry", // WorkMF crawl: enumerate the project's UMaterialFunction assets
            "Json",
            "JsonUtilities",
            "Landscape",
            "UnrealEd"
        });
    }
}
