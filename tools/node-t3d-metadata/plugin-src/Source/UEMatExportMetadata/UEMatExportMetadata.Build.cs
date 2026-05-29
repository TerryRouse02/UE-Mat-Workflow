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
            "Json",
            "JsonUtilities",
            "Landscape",
            "UnrealEd"
        });
    }
}
