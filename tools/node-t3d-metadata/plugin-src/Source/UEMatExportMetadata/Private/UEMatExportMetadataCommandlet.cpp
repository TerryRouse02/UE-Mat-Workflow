#include "UEMatExportMetadataCommandlet.h"

#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "EdGraphUtilities.h"
#include "HAL/FileManager.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "MaterialGraph/MaterialGraph.h"
#include "MaterialGraph/MaterialGraphNode.h"
#include "MaterialGraph/MaterialGraphNode_Comment.h"
#include "MaterialGraph/MaterialGraphSchema.h"
#include "Engine/Texture2D.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpression.h"
#include "Materials/MaterialExpressionAdd.h"
#include "Materials/MaterialExpressionComment.h"
#include "Materials/MaterialExpressionComponentMask.h"
#include "Materials/MaterialExpressionConstant.h"
#include "Materials/MaterialExpressionConstant3Vector.h"
#include "Materials/MaterialExpressionGetMaterialAttributes.h"
#include "Materials/MaterialExpressionLandscapeLayerBlend.h"
#include "Materials/MaterialExpressionMakeMaterialAttributes.h"
#include "Materials/MaterialExpressionMultiply.h"
#include "Materials/MaterialExpressionNamedReroute.h"
#include "Materials/MaterialExpressionSetMaterialAttributes.h"
#include "Materials/MaterialExpressionTextureSample.h"
#include "Materials/MaterialExpressionTextureSampleParameter2D.h"
#include "Materials/MaterialExpressionTransform.h"
#include "Materials/MaterialExpressionVectorParameter.h"
#include "MaterialShared.h" // FMaterialAttributeDefinitionMap (MaterialAttributes name<->GUID registry)
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Policies/PrettyJsonPrintPolicy.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UObject/Package.h"
#include "UObject/UnrealType.h"

#include UE_INLINE_GENERATED_CPP_BY_NAME(UEMatExportMetadataCommandlet)

namespace UE::MatExportMetadata
{
static const TSet<FString> DynamicNodeTypes =
{
    TEXT("SetMaterialAttributes"),
    TEXT("GetMaterialAttributes"),
    TEXT("LandscapeLayerBlend")
};

static TMap<FString, FString> BuildClassOverrides()
{
    TMap<FString, FString> Overrides;
    Overrides.Add(TEXT("Lerp"), TEXT("MaterialExpressionLinearInterpolate"));
    Overrides.Add(TEXT("TextureSampleParameterMovie"), TEXT("MaterialExpressionTextureSampleParameter2D"));
    Overrides.Add(TEXT("LandscapeLayerBlend"), TEXT("/Script/Landscape.MaterialExpressionLandscapeLayerBlend"));
    Overrides.Add(TEXT("LandscapeLayerCoords"), TEXT("/Script/Landscape.MaterialExpressionLandscapeLayerCoords"));
    Overrides.Add(TEXT("LandscapeLayerSwitch"), TEXT("/Script/Landscape.MaterialExpressionLandscapeLayerSwitch"));
    Overrides.Add(TEXT("LandscapeLayerWeight"), TEXT("/Script/Landscape.MaterialExpressionLandscapeLayerWeight"));
    Overrides.Add(TEXT("LandscapeVisibilityMask"), TEXT("/Script/Landscape.MaterialExpressionLandscapeVisibilityMask"));
    Overrides.Add(TEXT("PreSkinnedLocalNormal"), TEXT("MaterialExpressionPreSkinnedNormal"));
    Overrides.Add(TEXT("PreSkinnedLocalPosition"), TEXT("MaterialExpressionPreSkinnedPosition"));
    return Overrides;
}

static TMap<FString, FString> BuildFunctionAssetOverrides()
{
    TMap<FString, FString> Overrides;
    Overrides.Add(
        TEXT("BlendAngleCorrectedNormals"),
        TEXT("/Engine/Functions/Engine_MaterialFunctions02/Utility/BlendAngleCorrectedNormals.BlendAngleCorrectedNormals"));
    return Overrides;
}

static TMap<FString, TMap<FString, FString>> BuildInputOverrides()
{
    TMap<FString, TMap<FString, FString>> Overrides;
    Overrides.Add(TEXT("TextureSampleParameter2D"), {{TEXT("UVs"), TEXT("Coordinates")}, {TEXT("Tex"), TEXT("TextureObject")}});
    Overrides.Add(TEXT("TextureSample"), {{TEXT("UVs"), TEXT("Coordinates")}, {TEXT("Tex"), TEXT("TextureObject")}});
    Overrides.Add(TEXT("TextureSampleParameterSubUV"), {{TEXT("UVs"), TEXT("Coordinates")}});
    Overrides.Add(TEXT("TextureSampleParameterCube"), {{TEXT("UVs"), TEXT("Coordinates")}, {TEXT("Tex"), TEXT("TextureObject")}});
    Overrides.Add(TEXT("TextureSampleParameterMovie"), {{TEXT("UVs"), TEXT("Coordinates")}, {TEXT("Tex"), TEXT("TextureObject")}});
    Overrides.Add(TEXT("ParticleSubUV"), {{TEXT("UVs"), TEXT("Coordinates")}});
    Overrides.Add(TEXT("AntialiasedTextureMask"), {{TEXT("UVs"), TEXT("Coordinates")}});
    Overrides.Add(TEXT("Power"), {{TEXT("Exp"), TEXT("Exponent")}});
    Overrides.Add(TEXT("DepthFade"), {{TEXT("Opacity"), TEXT("InOpacity")}});
    Overrides.Add(TEXT("If"), {{TEXT("A > B"), TEXT("AGreaterThanB")}, {TEXT("A = B"), TEXT("AEqualsB")}, {TEXT("A < B"), TEXT("ALessThanB")}});
    Overrides.Add(TEXT("FeatureLevelSwitch"), {{TEXT("Default"), TEXT("Default")}, {TEXT("ES2"), TEXT("Inputs(0)")}, {TEXT("ES3.1"), TEXT("Inputs(1)")}, {TEXT("SM4"), TEXT("Inputs(2)")}, {TEXT("SM5"), TEXT("Inputs(3)")}});
    Overrides.Add(TEXT("QualitySwitch"), {{TEXT("Default"), TEXT("Default")}, {TEXT("Low"), TEXT("Inputs(0)")}, {TEXT("High"), TEXT("Inputs(1)")}});
    return Overrides;
}

static TMap<FString, TMap<FString, FString>> BuildParamPropertyOverrides()
{
    TMap<FString, TMap<FString, FString>> Overrides;
    Overrides.Add(TEXT("Transform"), {{TEXT("Source"), TEXT("TransformSourceType")}, {TEXT("Destination"), TEXT("TransformType")}});
    Overrides.Add(TEXT("TransformPosition"), {{TEXT("Source"), TEXT("TransformSourceType")}, {TEXT("Destination"), TEXT("TransformType")}});
    return Overrides;
}

static TMap<FString, FString> BuildSamplerTypeMap()
{
    TMap<FString, FString> Map;
    Map.Add(TEXT("Color"), TEXT("SAMPLERTYPE_Color"));
    Map.Add(TEXT("LinearColor"), TEXT("SAMPLERTYPE_LinearColor"));
    Map.Add(TEXT("Grayscale"), TEXT("SAMPLERTYPE_Grayscale"));
    Map.Add(TEXT("LinearGrayscale"), TEXT("SAMPLERTYPE_LinearGrayscale"));
    Map.Add(TEXT("Normal"), TEXT("SAMPLERTYPE_Normal"));
    Map.Add(TEXT("Alpha"), TEXT("SAMPLERTYPE_Alpha"));
    Map.Add(TEXT("Masks"), TEXT("SAMPLERTYPE_Masks"));
    Map.Add(TEXT("Data"), TEXT("SAMPLERTYPE_Data"));
    Map.Add(TEXT("External"), TEXT("SAMPLERTYPE_External"));
    Map.Add(TEXT("VirtualColor"), TEXT("SAMPLERTYPE_VirtualColor"));
    return Map;
}

static TMap<FString, FString> BuildTransformSourceMap()
{
    TMap<FString, FString> Map;
    Map.Add(TEXT("Tangent"), TEXT("TRANSFORMSOURCE_Tangent"));
    Map.Add(TEXT("Local"), TEXT("TRANSFORMSOURCE_Local"));
    Map.Add(TEXT("World"), TEXT("TRANSFORMSOURCE_World"));
    Map.Add(TEXT("View"), TEXT("TRANSFORMSOURCE_View"));
    Map.Add(TEXT("Camera"), TEXT("TRANSFORMSOURCE_Camera"));
    Map.Add(TEXT("ParticleWorld"), TEXT("TRANSFORMSOURCE_ParticleWorld"));
    Map.Add(TEXT("Particle"), TEXT("TRANSFORMSOURCE_ParticleWorld"));
    Map.Add(TEXT("Instance"), TEXT("TRANSFORMSOURCE_Instance"));
    return Map;
}

static TMap<FString, FString> BuildTransformDestinationMap()
{
    TMap<FString, FString> Map;
    Map.Add(TEXT("Tangent"), TEXT("TRANSFORM_Tangent"));
    Map.Add(TEXT("Local"), TEXT("TRANSFORM_Local"));
    Map.Add(TEXT("World"), TEXT("TRANSFORM_World"));
    Map.Add(TEXT("View"), TEXT("TRANSFORM_View"));
    Map.Add(TEXT("Camera"), TEXT("TRANSFORM_Camera"));
    Map.Add(TEXT("ParticleWorld"), TEXT("TRANSFORM_ParticleWorld"));
    Map.Add(TEXT("Particle"), TEXT("TRANSFORM_ParticleWorld"));
    Map.Add(TEXT("Instance"), TEXT("TRANSFORM_Instance"));
    return Map;
}

static TMap<FString, FString> BuildTransformPositionMap()
{
    TMap<FString, FString> Map;
    Map.Add(TEXT("Local"), TEXT("TRANSFORMPOSSOURCE_Local"));
    Map.Add(TEXT("World"), TEXT("TRANSFORMPOSSOURCE_World"));
    Map.Add(TEXT("AbsoluteWorld"), TEXT("TRANSFORMPOSSOURCE_World"));
    Map.Add(TEXT("PeriodicWorld"), TEXT("TRANSFORMPOSSOURCE_PeriodicWorld"));
    Map.Add(TEXT("TranslatedWorld"), TEXT("TRANSFORMPOSSOURCE_TranslatedWorld"));
    Map.Add(TEXT("CameraRelativeWorld"), TEXT("TRANSFORMPOSSOURCE_TranslatedWorld"));
    Map.Add(TEXT("FirstPersonTranslatedWorld"), TEXT("TRANSFORMPOSSOURCE_FirstPersonTranslatedWorld"));
    Map.Add(TEXT("View"), TEXT("TRANSFORMPOSSOURCE_View"));
    Map.Add(TEXT("Camera"), TEXT("TRANSFORMPOSSOURCE_Camera"));
    Map.Add(TEXT("Particle"), TEXT("TRANSFORMPOSSOURCE_Particle"));
    Map.Add(TEXT("ParticleWorld"), TEXT("TRANSFORMPOSSOURCE_Particle"));
    Map.Add(TEXT("Instance"), TEXT("TRANSFORMPOSSOURCE_Instance"));
    return Map;
}

static void SetValueMapFromPairs(TSharedRef<FJsonObject> ParamMeta, const TMap<FString, FString>& Pairs)
{
    TSharedRef<FJsonObject> ValueMap = MakeShared<FJsonObject>();
    for (const TPair<FString, FString>& Pair : Pairs)
    {
        ValueMap->SetStringField(Pair.Key, Pair.Value);
    }
    ParamMeta->SetObjectField(TEXT("valueMap"), ValueMap);
}

static FString ToAbsolutePath(const FString& Path)
{
    return FPaths::ConvertRelativePathToFull(Path);
}

static bool LoadJsonFile(const FString& Path, TSharedPtr<FJsonObject>& OutObject, FString& OutError)
{
    FString Text;
    if (!FFileHelper::LoadFileToString(Text, *Path))
    {
        OutError = FString::Printf(TEXT("Failed to read JSON file: %s"), *Path);
        return false;
    }

    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
    if (!FJsonSerializer::Deserialize(Reader, OutObject) || !OutObject.IsValid())
    {
        OutError = FString::Printf(TEXT("Failed to parse JSON file: %s"), *Path);
        return false;
    }

    return true;
}

static bool WriteMakeMaterialAttributesClipboardSample(const FString& Path, FString& OutError)
{
    UMaterial* Material = NewObject<UMaterial>(
        GetTransientPackage(),
        TEXT("UEMatWorkflowClipboard"),
        RF_Transient | RF_Transactional);
    if (Material == nullptr)
    {
        OutError = TEXT("Failed to create transient material.");
        return false;
    }

    Material->bUseMaterialAttributes = true;
    Material->MaterialGraph = CastChecked<UMaterialGraph>(FBlueprintEditorUtils::CreateNewGraph(
        Material,
        FName(TEXT("MaterialGraph_0")),
        UMaterialGraph::StaticClass(),
        UMaterialGraphSchema::StaticClass()));
    Material->MaterialGraph->Material = Material;

    UMaterialExpressionConstant3Vector* BaseColor = NewObject<UMaterialExpressionConstant3Vector>(
        Material,
        NAME_None,
        RF_Transactional);
    UMaterialExpressionTextureSample* TextureSample = NewObject<UMaterialExpressionTextureSample>(
        Material,
        NAME_None,
        RF_Transactional);
    UMaterialExpressionConstant3Vector* MultiplyA = NewObject<UMaterialExpressionConstant3Vector>(
        Material,
        NAME_None,
        RF_Transactional);
    UMaterialExpressionConstant3Vector* MultiplyB = NewObject<UMaterialExpressionConstant3Vector>(
        Material,
        NAME_None,
        RF_Transactional);
    UMaterialExpressionMultiply* EmissiveMultiply = NewObject<UMaterialExpressionMultiply>(
        Material,
        NAME_None,
        RF_Transactional);
    UMaterialExpressionConstant* Metallic = NewObject<UMaterialExpressionConstant>(
        Material,
        NAME_None,
        RF_Transactional);
    UMaterialExpressionMakeMaterialAttributes* MakeAttributes = NewObject<UMaterialExpressionMakeMaterialAttributes>(
        Material,
        NAME_None,
        RF_Transactional);

    if (BaseColor == nullptr || TextureSample == nullptr || MultiplyA == nullptr || MultiplyB == nullptr ||
        EmissiveMultiply == nullptr || Metallic == nullptr || MakeAttributes == nullptr)
    {
        OutError = TEXT("Failed to create material expression nodes.");
        return false;
    }

    BaseColor->Material = Material;
    BaseColor->Constant = FLinearColor(1.0f, 0.0f, 0.0f, 1.0f);
    BaseColor->MaterialExpressionEditorX = -520;
    BaseColor->MaterialExpressionEditorY = -120;
    Material->GetExpressionCollection().AddExpression(BaseColor);

    TextureSample->Material = Material;
    TextureSample->MaterialExpressionEditorX = -520;
    TextureSample->MaterialExpressionEditorY = 80;
    Material->GetExpressionCollection().AddExpression(TextureSample);

    MultiplyA->Material = Material;
    MultiplyA->Constant = FLinearColor(0.2f, 0.4f, 0.8f, 1.0f);
    MultiplyA->MaterialExpressionEditorX = -760;
    MultiplyA->MaterialExpressionEditorY = 260;
    Material->GetExpressionCollection().AddExpression(MultiplyA);

    MultiplyB->Material = Material;
    MultiplyB->Constant = FLinearColor(2.0f, 1.0f, 0.5f, 1.0f);
    MultiplyB->MaterialExpressionEditorX = -760;
    MultiplyB->MaterialExpressionEditorY = 420;
    Material->GetExpressionCollection().AddExpression(MultiplyB);

    EmissiveMultiply->Material = Material;
    EmissiveMultiply->MaterialExpressionEditorX = -520;
    EmissiveMultiply->MaterialExpressionEditorY = 340;
    EmissiveMultiply->A.Connect(0, MultiplyA);
    EmissiveMultiply->B.Connect(0, MultiplyB);
    Material->GetExpressionCollection().AddExpression(EmissiveMultiply);

    Metallic->Material = Material;
    Metallic->R = 0.5f;
    Metallic->MaterialExpressionEditorX = -520;
    Metallic->MaterialExpressionEditorY = 560;
    Material->GetExpressionCollection().AddExpression(Metallic);

    MakeAttributes->Material = Material;
    MakeAttributes->MaterialExpressionEditorX = -180;
    MakeAttributes->MaterialExpressionEditorY = 160;
    MakeAttributes->BaseColor.Connect(0, BaseColor);
    MakeAttributes->Normal.Connect(0, TextureSample);
    MakeAttributes->Roughness.Connect(1, TextureSample);
    MakeAttributes->EmissiveColor.Connect(0, EmissiveMultiply);
    MakeAttributes->Metallic.Connect(0, Metallic);
    Material->GetExpressionCollection().AddExpression(MakeAttributes);

    FExpressionInput* MaterialAttributesInput = Material->GetExpressionInputForProperty(MP_MaterialAttributes);
    if (MaterialAttributesInput == nullptr)
    {
        OutError = TEXT("Failed to resolve the root Material Attributes input.");
        return false;
    }
    MaterialAttributesInput->Connect(0, MakeAttributes);

    Material->MaterialGraph->RebuildGraph();

    TArray<UMaterialExpression*> ExpressionsToCopy = {
        BaseColor,
        TextureSample,
        MultiplyA,
        MultiplyB,
        EmissiveMultiply,
        Metallic,
        MakeAttributes
    };
    TSet<UObject*> NodesToExport;
    for (UMaterialExpression* Expression : ExpressionsToCopy)
    {
        UEdGraphNode* GraphNode = Cast<UEdGraphNode>(Expression->GraphNode);
        if (GraphNode == nullptr)
        {
            OutError = FString::Printf(TEXT("Failed to create graph node for %s."), *Expression->GetName());
            return false;
        }
        NodesToExport.Add(GraphNode);
    }

    for (UObject* NodeObject : NodesToExport)
    {
        if (UEdGraphNode* Node = Cast<UEdGraphNode>(NodeObject))
        {
            Node->PrepareForCopying();
        }
    }

    FString ExportedText;
    FEdGraphUtilities::ExportNodesToText(NodesToExport, ExportedText);

    for (UObject* NodeObject : NodesToExport)
    {
        if (UMaterialGraphNode* Node = Cast<UMaterialGraphNode>(NodeObject))
        {
            Node->PostCopyNode();
        }
    }

    if (ExportedText.IsEmpty())
    {
        OutError = TEXT("UE exported an empty clipboard sample.");
        return false;
    }

    IFileManager::Get().MakeDirectory(*FPaths::GetPath(Path), true);
    if (!FFileHelper::SaveStringToFile(ExportedText, *Path, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
    {
        OutError = FString::Printf(TEXT("Failed to write clipboard sample: %s"), *Path);
        return false;
    }

    if (UMaterialGraphNode* MakeNode = Cast<UMaterialGraphNode>(MakeAttributes->GraphNode))
    {
        for (const UEdGraphPin* Pin : MakeNode->Pins)
        {
            UE_LOG(
                LogTemp,
                Display,
                TEXT("MakeMaterialAttributes pin: Direction=%s SourceIndex=%d PinName=\"%s\""),
                Pin->Direction == EGPD_Input ? TEXT("Input") : TEXT("Output"),
                Pin->SourceIndex,
                *Pin->PinName.ToString());
        }
    }

    UE_LOG(LogTemp, Display, TEXT("Wrote MakeMaterialAttributes clipboard sample: %s"), *Path);
    return true;
}

static bool WriteCoreClipboardSample(const FString& Path, const FString& TextureAssetPath, FString& OutError)
{
    UTexture2D* Texture = LoadObject<UTexture2D>(nullptr, *TextureAssetPath);
    if (Texture == nullptr)
    {
        OutError = FString::Printf(TEXT("Failed to load Texture2D asset: %s"), *TextureAssetPath);
        return false;
    }

    UMaterial* Material = NewObject<UMaterial>(
        GetTransientPackage(),
        TEXT("UEMatWorkflowClipboard"),
        RF_Transient | RF_Transactional);
    if (Material == nullptr)
    {
        OutError = TEXT("Failed to create transient material.");
        return false;
    }

    Material->MaterialGraph = CastChecked<UMaterialGraph>(FBlueprintEditorUtils::CreateNewGraph(
        Material,
        FName(TEXT("MaterialGraph_0")),
        UMaterialGraph::StaticClass(),
        UMaterialGraphSchema::StaticClass()));
    Material->MaterialGraph->Material = Material;

    UMaterialExpressionConstant* Constant = NewObject<UMaterialExpressionConstant>(Material, NAME_None, RF_Transactional);
    UMaterialExpressionAdd* Add = NewObject<UMaterialExpressionAdd>(Material, NAME_None, RF_Transactional);
    UMaterialExpressionVectorParameter* VectorParameter = NewObject<UMaterialExpressionVectorParameter>(Material, NAME_None, RF_Transactional);
    UMaterialExpressionTextureSampleParameter2D* TextureParameter = NewObject<UMaterialExpressionTextureSampleParameter2D>(Material, NAME_None, RF_Transactional);
    UMaterialExpressionTransform* Transform = NewObject<UMaterialExpressionTransform>(Material, NAME_None, RF_Transactional);
    UMaterialExpressionComponentMask* ComponentMask = NewObject<UMaterialExpressionComponentMask>(Material, NAME_None, RF_Transactional);
    UMaterialExpressionComment* Comment = NewObject<UMaterialExpressionComment>(Material, NAME_None, RF_Transactional);
    if (Constant == nullptr || Add == nullptr || VectorParameter == nullptr || TextureParameter == nullptr ||
        Transform == nullptr || ComponentMask == nullptr || Comment == nullptr)
    {
        OutError = TEXT("Failed to create core clipboard material expressions.");
        return false;
    }

    Constant->Material = Material;
    Constant->R = 1.0f;
    Constant->MaterialExpressionEditorX = 0;
    Constant->MaterialExpressionEditorY = 0;
    Material->GetExpressionCollection().AddExpression(Constant);

    Add->Material = Material;
    Add->A.Connect(0, Constant);
    Add->B.Connect(1, VectorParameter);
    Add->MaterialExpressionEditorX = 260;
    Add->MaterialExpressionEditorY = 0;
    Material->GetExpressionCollection().AddExpression(Add);

    VectorParameter->Material = Material;
    VectorParameter->ParameterName = TEXT("Color");
    VectorParameter->DefaultValue = FLinearColor(1.0f, 1.0f, 1.0f, 1.0f);
    VectorParameter->MaterialExpressionEditorX = 0;
    VectorParameter->MaterialExpressionEditorY = 180;
    Material->GetExpressionCollection().AddExpression(VectorParameter);

    TextureParameter->Material = Material;
    TextureParameter->ParameterName = TEXT("MaskTexture");
    TextureParameter->Texture = Texture;
    TextureParameter->AutoSetSampleType();
    TextureParameter->SamplerType = SAMPLERTYPE_Masks;
    TextureParameter->MaterialExpressionEditorX = 560;
    TextureParameter->MaterialExpressionEditorY = 0;
    Material->GetExpressionCollection().AddExpression(TextureParameter);

    Transform->Material = Material;
    Transform->TransformSourceType = TRANSFORMSOURCE_World;
    Transform->TransformType = TRANSFORM_Tangent;
    Transform->MaterialExpressionEditorX = 560;
    Transform->MaterialExpressionEditorY = 220;
    Material->GetExpressionCollection().AddExpression(Transform);

    ComponentMask->Material = Material;
    ComponentMask->Input.Connect(0, TextureParameter);
    ComponentMask->R = 1;
    ComponentMask->G = 0;
    ComponentMask->B = 0;
    ComponentMask->A = 0;
    ComponentMask->MaterialExpressionEditorX = 820;
    ComponentMask->MaterialExpressionEditorY = 0;
    Material->GetExpressionCollection().AddExpression(ComponentMask);

    Comment->Material = Material;
    Comment->Text = TEXT("Core clipboard calibration");
    Comment->SizeX = 1120;
    Comment->SizeY = 420;
    Comment->CommentColor = FLinearColor(0.5f, 0.5f, 0.5f, 1.0f);
    Comment->MaterialExpressionEditorX = -80;
    Comment->MaterialExpressionEditorY = -80;
    Material->GetExpressionCollection().AddComment(Comment);

    Material->MaterialGraph->RebuildGraph();

    TArray<UMaterialExpression*> ExpressionsToCopy = {
        Constant,
        Add,
        VectorParameter,
        TextureParameter,
        Transform,
        ComponentMask
    };

    TSet<UObject*> NodesToExport;
    for (UMaterialExpression* Expression : ExpressionsToCopy)
    {
        UEdGraphNode* GraphNode = Cast<UEdGraphNode>(Expression->GraphNode);
        if (GraphNode == nullptr)
        {
            OutError = FString::Printf(TEXT("Failed to create graph node for %s."), *Expression->GetName());
            return false;
        }
        NodesToExport.Add(GraphNode);
    }

    UEdGraphNode* CommentNode = Cast<UEdGraphNode>(Comment->GraphNode);
    if (CommentNode == nullptr)
    {
        OutError = TEXT("Failed to create graph node for the core clipboard comment.");
        return false;
    }
    NodesToExport.Add(CommentNode);

    for (UObject* NodeObject : NodesToExport)
    {
        if (UEdGraphNode* Node = Cast<UEdGraphNode>(NodeObject))
        {
            Node->PrepareForCopying();
        }
    }

    FString ExportedText;
    FEdGraphUtilities::ExportNodesToText(NodesToExport, ExportedText);

    for (UObject* NodeObject : NodesToExport)
    {
        if (UMaterialGraphNode* MaterialNode = Cast<UMaterialGraphNode>(NodeObject))
        {
            MaterialNode->PostCopyNode();
        }
        else if (UMaterialGraphNode_Comment* CommentGraphNode = Cast<UMaterialGraphNode_Comment>(NodeObject))
        {
            CommentGraphNode->PostCopyNode();
        }
    }

    if (ExportedText.IsEmpty())
    {
        OutError = TEXT("UE exported an empty core clipboard sample.");
        return false;
    }

    IFileManager::Get().MakeDirectory(*FPaths::GetPath(Path), true);
    if (!FFileHelper::SaveStringToFile(ExportedText, *Path, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
    {
        OutError = FString::Printf(TEXT("Failed to write core clipboard sample: %s"), *Path);
        return false;
    }

    UE_LOG(LogTemp, Display, TEXT("Core clipboard texture asset: %s"), *Texture->GetPathName());
    UE_LOG(LogTemp, Display, TEXT("Wrote core clipboard sample: %s"), *Path);
    return true;
}

static bool WriteTextureSampleClipboardSample(const FString& Path, const FString& TextureAssetPath, FString& OutError)
{
    UTexture2D* Texture = LoadObject<UTexture2D>(nullptr, *TextureAssetPath);
    if (Texture == nullptr)
    {
        OutError = FString::Printf(TEXT("Failed to load Texture2D asset: %s"), *TextureAssetPath);
        return false;
    }

    UMaterial* Material = NewObject<UMaterial>(
        GetTransientPackage(),
        TEXT("UEMatWorkflowClipboard"),
        RF_Transient | RF_Transactional);
    if (Material == nullptr)
    {
        OutError = TEXT("Failed to create transient material.");
        return false;
    }

    Material->MaterialGraph = CastChecked<UMaterialGraph>(FBlueprintEditorUtils::CreateNewGraph(
        Material,
        FName(TEXT("MaterialGraph_0")),
        UMaterialGraph::StaticClass(),
        UMaterialGraphSchema::StaticClass()));
    Material->MaterialGraph->Material = Material;

    UMaterialExpressionTextureSample* TextureSample = NewObject<UMaterialExpressionTextureSample>(
        Material,
        NAME_None,
        RF_Transactional);
    UMaterialExpressionTextureSampleParameter2D* TextureParameter = NewObject<UMaterialExpressionTextureSampleParameter2D>(
        Material,
        NAME_None,
        RF_Transactional);
    if (TextureSample == nullptr || TextureParameter == nullptr)
    {
        OutError = TEXT("Failed to create texture sample expressions.");
        return false;
    }

    TextureSample->Material = Material;
    TextureSample->Texture = Texture;
    TextureSample->MaterialExpressionEditorX = -320;
    TextureSample->MaterialExpressionEditorY = -120;
    TextureSample->AutoSetSampleType();
    Material->GetExpressionCollection().AddExpression(TextureSample);

    TextureParameter->Material = Material;
    TextureParameter->Texture = Texture;
    TextureParameter->ParameterName = TEXT("WF_TextureProbe");
    TextureParameter->MaterialExpressionEditorX = -320;
    TextureParameter->MaterialExpressionEditorY = 120;
    TextureParameter->AutoSetSampleType();
    Material->GetExpressionCollection().AddExpression(TextureParameter);

    Material->MaterialGraph->RebuildGraph();

    TArray<UMaterialExpression*> ExpressionsToCopy = {
        TextureSample,
        TextureParameter
    };
    TSet<UObject*> NodesToExport;
    for (UMaterialExpression* Expression : ExpressionsToCopy)
    {
        UEdGraphNode* GraphNode = Cast<UEdGraphNode>(Expression->GraphNode);
        if (GraphNode == nullptr)
        {
            OutError = FString::Printf(TEXT("Failed to create graph node for %s."), *Expression->GetName());
            return false;
        }
        NodesToExport.Add(GraphNode);
    }

    for (UObject* NodeObject : NodesToExport)
    {
        if (UEdGraphNode* Node = Cast<UEdGraphNode>(NodeObject))
        {
            Node->PrepareForCopying();
        }
    }

    FString ExportedText;
    FEdGraphUtilities::ExportNodesToText(NodesToExport, ExportedText);

    for (UObject* NodeObject : NodesToExport)
    {
        if (UMaterialGraphNode* Node = Cast<UMaterialGraphNode>(NodeObject))
        {
            Node->PostCopyNode();
        }
    }

    if (ExportedText.IsEmpty())
    {
        OutError = TEXT("UE exported an empty texture sample clipboard sample.");
        return false;
    }

    IFileManager::Get().MakeDirectory(*FPaths::GetPath(Path), true);
    if (!FFileHelper::SaveStringToFile(ExportedText, *Path, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
    {
        OutError = FString::Printf(TEXT("Failed to write texture sample clipboard sample: %s"), *Path);
        return false;
    }

    UE_LOG(LogTemp, Display, TEXT("Texture sample source asset: %s"), *Texture->GetPathName());
    UE_LOG(LogTemp, Display, TEXT("Wrote TextureSample clipboard sample: %s"), *Path);
    return true;
}

static bool WriteNamedRerouteClipboardSample(const FString& Path, FString& OutError)
{
    UMaterial* Material = NewObject<UMaterial>(
        GetTransientPackage(),
        TEXT("UEMatWorkflowClipboard"),
        RF_Transient | RF_Transactional);
    if (Material == nullptr)
    {
        OutError = TEXT("Failed to create transient material.");
        return false;
    }

    Material->MaterialGraph = CastChecked<UMaterialGraph>(FBlueprintEditorUtils::CreateNewGraph(
        Material,
        FName(TEXT("MaterialGraph_0")),
        UMaterialGraph::StaticClass(),
        UMaterialGraphSchema::StaticClass()));
    Material->MaterialGraph->Material = Material;

    UMaterialExpressionConstant* Constant = NewObject<UMaterialExpressionConstant>(Material, NAME_None, RF_Transactional);
    UMaterialExpressionNamedRerouteDeclaration* Declaration = NewObject<UMaterialExpressionNamedRerouteDeclaration>(Material, NAME_None, RF_Transactional);
    UMaterialExpressionNamedRerouteUsage* Usage = NewObject<UMaterialExpressionNamedRerouteUsage>(Material, NAME_None, RF_Transactional);
    UMaterialExpressionAdd* Add = NewObject<UMaterialExpressionAdd>(Material, NAME_None, RF_Transactional);
    if (Constant == nullptr || Declaration == nullptr || Usage == nullptr || Add == nullptr)
    {
        OutError = TEXT("Failed to create named reroute clipboard material expressions.");
        return false;
    }

    Constant->Material = Material;
    Constant->R = 1.0f;
    Constant->MaterialExpressionEditorX = -700;
    Constant->MaterialExpressionEditorY = 0;
    Material->GetExpressionCollection().AddExpression(Constant);

    Declaration->Material = Material;
    Declaration->Name = TEXT("WF_Name");
    Declaration->NodeColor = FLinearColor(0.1f, 0.4f, 0.8f, 1.0f);
    Declaration->VariableGuid = FGuid(0x12345678, 0x90abcdef, 0x13572468, 0x24681357);
    Declaration->Input.Connect(0, Constant);
    Declaration->MaterialExpressionEditorX = -420;
    Declaration->MaterialExpressionEditorY = 0;
    Material->GetExpressionCollection().AddExpression(Declaration);

    Usage->Material = Material;
    Usage->Declaration = Declaration;
    Usage->DeclarationGuid = Declaration->VariableGuid;
    Usage->MaterialExpressionEditorX = -160;
    Usage->MaterialExpressionEditorY = 0;
    Material->GetExpressionCollection().AddExpression(Usage);

    Add->Material = Material;
    Add->A.Connect(0, Usage);
    Add->ConstB = 2.0f;
    Add->MaterialExpressionEditorX = 120;
    Add->MaterialExpressionEditorY = 0;
    Material->GetExpressionCollection().AddExpression(Add);

    FExpressionInput* EmissiveInput = Material->GetExpressionInputForProperty(MP_EmissiveColor);
    if (EmissiveInput == nullptr)
    {
        OutError = TEXT("Failed to resolve the root Emissive Color input.");
        return false;
    }
    EmissiveInput->Connect(0, Add);
    Material->MaterialGraph->RebuildGraph();

    TArray<UMaterialExpression*> ExpressionsToCopy = { Constant, Declaration, Usage, Add };
    TSet<UObject*> NodesToExport;
    for (UMaterialExpression* Expression : ExpressionsToCopy)
    {
        UEdGraphNode* GraphNode = Cast<UEdGraphNode>(Expression->GraphNode);
        if (GraphNode == nullptr)
        {
            OutError = FString::Printf(TEXT("Failed to create graph node for %s."), *Expression->GetName());
            return false;
        }
        NodesToExport.Add(GraphNode);
    }

    for (UObject* NodeObject : NodesToExport)
    {
        if (UEdGraphNode* Node = Cast<UEdGraphNode>(NodeObject))
        {
            Node->PrepareForCopying();
        }
    }

    FString ExportedText;
    FEdGraphUtilities::ExportNodesToText(NodesToExport, ExportedText);

    for (UObject* NodeObject : NodesToExport)
    {
        if (UMaterialGraphNode* Node = Cast<UMaterialGraphNode>(NodeObject))
        {
            Node->PostCopyNode();
        }
    }

    if (ExportedText.IsEmpty())
    {
        OutError = TEXT("UE exported an empty named reroute clipboard sample.");
        return false;
    }

    IFileManager::Get().MakeDirectory(*FPaths::GetPath(Path), true);
    if (!FFileHelper::SaveStringToFile(ExportedText, *Path, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
    {
        OutError = FString::Printf(TEXT("Failed to write named reroute clipboard sample: %s"), *Path);
        return false;
    }

    UE_LOG(LogTemp, Display, TEXT("Named reroute declaration guid: %s"), *Declaration->VariableGuid.ToString());
    UE_LOG(LogTemp, Display, TEXT("Wrote NamedReroute clipboard sample: %s"), *Path);
    return true;
}

static UMaterial* CreateTransientClipboardMaterial(bool bUseMaterialAttributes, FString& OutError)
{
    UMaterial* Material = NewObject<UMaterial>(
        GetTransientPackage(),
        TEXT("UEMatWorkflowClipboard"),
        RF_Transient | RF_Transactional);
    if (Material == nullptr)
    {
        OutError = TEXT("Failed to create transient material.");
        return nullptr;
    }

    Material->bUseMaterialAttributes = bUseMaterialAttributes;
    Material->MaterialGraph = CastChecked<UMaterialGraph>(FBlueprintEditorUtils::CreateNewGraph(
        Material,
        FName(TEXT("MaterialGraph_0")),
        UMaterialGraph::StaticClass(),
        UMaterialGraphSchema::StaticClass()));
    Material->MaterialGraph->Material = Material;
    return Material;
}

static bool ExportExpressionsToClipboardSample(
    const FString& Path,
    const TArray<UMaterialExpression*>& ExpressionsToCopy,
    const TCHAR* SampleName,
    FString& OutError)
{
    TSet<UObject*> NodesToExport;
    for (UMaterialExpression* Expression : ExpressionsToCopy)
    {
        if (Expression == nullptr)
        {
            OutError = FString::Printf(TEXT("Null expression in %s clipboard sample."), SampleName);
            return false;
        }

        UEdGraphNode* GraphNode = Cast<UEdGraphNode>(Expression->GraphNode);
        if (GraphNode == nullptr)
        {
            OutError = FString::Printf(TEXT("Failed to create graph node for %s."), *Expression->GetName());
            return false;
        }
        NodesToExport.Add(GraphNode);
    }

    for (UObject* NodeObject : NodesToExport)
    {
        if (UEdGraphNode* Node = Cast<UEdGraphNode>(NodeObject))
        {
            Node->PrepareForCopying();
        }
    }

    FString ExportedText;
    FEdGraphUtilities::ExportNodesToText(NodesToExport, ExportedText);

    for (UObject* NodeObject : NodesToExport)
    {
        if (UMaterialGraphNode* Node = Cast<UMaterialGraphNode>(NodeObject))
        {
            Node->PostCopyNode();
        }
    }

    if (ExportedText.IsEmpty())
    {
        OutError = FString::Printf(TEXT("UE exported an empty %s clipboard sample."), SampleName);
        return false;
    }

    IFileManager::Get().MakeDirectory(*FPaths::GetPath(Path), true);
    if (!FFileHelper::SaveStringToFile(ExportedText, *Path, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
    {
        OutError = FString::Printf(TEXT("Failed to write %s clipboard sample: %s"), SampleName, *Path);
        return false;
    }

    UE_LOG(LogTemp, Display, TEXT("Wrote %s clipboard sample: %s"), SampleName, *Path);
    return true;
}

static bool WriteSetMaterialAttributesClipboardSample(const FString& Path, FString& OutError)
{
    UMaterial* Material = CreateTransientClipboardMaterial(true, OutError);
    if (Material == nullptr)
    {
        return false;
    }

    UMaterialExpressionMakeMaterialAttributes* SourceAttributes = NewObject<UMaterialExpressionMakeMaterialAttributes>(Material, NAME_None, RF_Transactional);
    UMaterialExpressionConstant3Vector* BaseColor = NewObject<UMaterialExpressionConstant3Vector>(Material, NAME_None, RF_Transactional);
    UMaterialExpressionConstant* Roughness = NewObject<UMaterialExpressionConstant>(Material, NAME_None, RF_Transactional);
    UMaterialExpressionConstant* Metallic = NewObject<UMaterialExpressionConstant>(Material, NAME_None, RF_Transactional);
    UMaterialExpressionSetMaterialAttributes* SetAttributes = NewObject<UMaterialExpressionSetMaterialAttributes>(Material, NAME_None, RF_Transactional);
    if (SourceAttributes == nullptr || BaseColor == nullptr || Roughness == nullptr || Metallic == nullptr || SetAttributes == nullptr)
    {
        OutError = TEXT("Failed to create SetMaterialAttributes clipboard material expressions.");
        return false;
    }

    SourceAttributes->Material = Material;
    SourceAttributes->MaterialExpressionEditorX = -760;
    SourceAttributes->MaterialExpressionEditorY = -120;
    Material->GetExpressionCollection().AddExpression(SourceAttributes);

    BaseColor->Material = Material;
    BaseColor->Constant = FLinearColor(0.1f, 0.45f, 0.9f, 1.0f);
    BaseColor->MaterialExpressionEditorX = -760;
    BaseColor->MaterialExpressionEditorY = 120;
    Material->GetExpressionCollection().AddExpression(BaseColor);

    Roughness->Material = Material;
    Roughness->R = 0.35f;
    Roughness->MaterialExpressionEditorX = -760;
    Roughness->MaterialExpressionEditorY = 300;
    Material->GetExpressionCollection().AddExpression(Roughness);

    Metallic->Material = Material;
    Metallic->R = 0.8f;
    Metallic->MaterialExpressionEditorX = -760;
    Metallic->MaterialExpressionEditorY = 460;
    Material->GetExpressionCollection().AddExpression(Metallic);

    SetAttributes->Material = Material;
    SetAttributes->MaterialExpressionEditorX = -300;
    SetAttributes->MaterialExpressionEditorY = 140;
    SetAttributes->Inputs[0].Connect(0, SourceAttributes);
    SetAttributes->ConnectInputAttribute(MP_BaseColor, BaseColor);
    SetAttributes->ConnectInputAttribute(MP_Roughness, Roughness);
    SetAttributes->ConnectInputAttribute(MP_Metallic, Metallic);
    Material->GetExpressionCollection().AddExpression(SetAttributes);

    if (FExpressionInput* MaterialAttributesInput = Material->GetExpressionInputForProperty(MP_MaterialAttributes))
    {
        MaterialAttributesInput->Connect(0, SetAttributes);
    }

    Material->MaterialGraph->RebuildGraph();

    if (UMaterialGraphNode* SetNode = Cast<UMaterialGraphNode>(SetAttributes->GraphNode))
    {
        for (const UEdGraphPin* Pin : SetNode->Pins)
        {
            UE_LOG(
                LogTemp,
                Display,
                TEXT("SetMaterialAttributes pin: Direction=%s SourceIndex=%d PinName=\"%s\""),
                Pin->Direction == EGPD_Input ? TEXT("Input") : TEXT("Output"),
                Pin->SourceIndex,
                *Pin->PinName.ToString());
        }
    }

    return ExportExpressionsToClipboardSample(
        Path,
        { SourceAttributes, BaseColor, Roughness, Metallic, SetAttributes },
        TEXT("SetMaterialAttributes"),
        OutError);
}

static bool WriteGetMaterialAttributesClipboardSample(const FString& Path, FString& OutError)
{
    UMaterial* Material = CreateTransientClipboardMaterial(true, OutError);
    if (Material == nullptr)
    {
        return false;
    }

    UMaterialExpressionMakeMaterialAttributes* SourceAttributes = NewObject<UMaterialExpressionMakeMaterialAttributes>(Material, NAME_None, RF_Transactional);
    UMaterialExpressionGetMaterialAttributes* GetAttributes = NewObject<UMaterialExpressionGetMaterialAttributes>(Material, NAME_None, RF_Transactional);
    UMaterialExpressionComponentMask* BaseColorR = NewObject<UMaterialExpressionComponentMask>(Material, NAME_None, RF_Transactional);
    UMaterialExpressionMultiply* RoughnessScale = NewObject<UMaterialExpressionMultiply>(Material, NAME_None, RF_Transactional);
    UMaterialExpressionAdd* MetallicOffset = NewObject<UMaterialExpressionAdd>(Material, NAME_None, RF_Transactional);
    if (SourceAttributes == nullptr || GetAttributes == nullptr || BaseColorR == nullptr || RoughnessScale == nullptr || MetallicOffset == nullptr)
    {
        OutError = TEXT("Failed to create GetMaterialAttributes clipboard material expressions.");
        return false;
    }

    SourceAttributes->Material = Material;
    SourceAttributes->MaterialExpressionEditorX = -760;
    SourceAttributes->MaterialExpressionEditorY = 60;
    Material->GetExpressionCollection().AddExpression(SourceAttributes);

    GetAttributes->Material = Material;
    GetAttributes->MaterialAttributes.Connect(0, SourceAttributes);
    const int32 BaseColorOutput = GetAttributes->CreateOrGetOutputAttribute(MP_BaseColor);
    const int32 RoughnessOutput = GetAttributes->CreateOrGetOutputAttribute(MP_Roughness);
    const int32 MetallicOutput = GetAttributes->CreateOrGetOutputAttribute(MP_Metallic);
    GetAttributes->MaterialExpressionEditorX = -420;
    GetAttributes->MaterialExpressionEditorY = 60;
    Material->GetExpressionCollection().AddExpression(GetAttributes);

    BaseColorR->Material = Material;
    BaseColorR->Input.Connect(BaseColorOutput, GetAttributes);
    BaseColorR->R = 1;
    BaseColorR->G = 0;
    BaseColorR->B = 0;
    BaseColorR->A = 0;
    BaseColorR->MaterialExpressionEditorX = -80;
    BaseColorR->MaterialExpressionEditorY = -120;
    Material->GetExpressionCollection().AddExpression(BaseColorR);

    RoughnessScale->Material = Material;
    RoughnessScale->A.Connect(RoughnessOutput, GetAttributes);
    RoughnessScale->ConstB = 0.5f;
    RoughnessScale->MaterialExpressionEditorX = -80;
    RoughnessScale->MaterialExpressionEditorY = 80;
    Material->GetExpressionCollection().AddExpression(RoughnessScale);

    MetallicOffset->Material = Material;
    MetallicOffset->A.Connect(MetallicOutput, GetAttributes);
    MetallicOffset->ConstB = 0.1f;
    MetallicOffset->MaterialExpressionEditorX = -80;
    MetallicOffset->MaterialExpressionEditorY = 280;
    Material->GetExpressionCollection().AddExpression(MetallicOffset);

    Material->MaterialGraph->RebuildGraph();

    if (UMaterialGraphNode* GetNode = Cast<UMaterialGraphNode>(GetAttributes->GraphNode))
    {
        for (const UEdGraphPin* Pin : GetNode->Pins)
        {
            UE_LOG(
                LogTemp,
                Display,
                TEXT("GetMaterialAttributes pin: Direction=%s SourceIndex=%d PinName=\"%s\""),
                Pin->Direction == EGPD_Input ? TEXT("Input") : TEXT("Output"),
                Pin->SourceIndex,
                *Pin->PinName.ToString());
        }
    }

    return ExportExpressionsToClipboardSample(
        Path,
        { SourceAttributes, GetAttributes, BaseColorR, RoughnessScale, MetallicOffset },
        TEXT("GetMaterialAttributes"),
        OutError);
}

static bool WriteLandscapeLayerBlendClipboardSample(const FString& Path, FString& OutError)
{
    UMaterial* Material = CreateTransientClipboardMaterial(false, OutError);
    if (Material == nullptr)
    {
        return false;
    }

    UMaterialExpressionConstant3Vector* DirtColor = NewObject<UMaterialExpressionConstant3Vector>(Material, NAME_None, RF_Transactional);
    UMaterialExpressionConstant* DirtHeight = NewObject<UMaterialExpressionConstant>(Material, NAME_None, RF_Transactional);
    UMaterialExpressionConstant3Vector* GrassColor = NewObject<UMaterialExpressionConstant3Vector>(Material, NAME_None, RF_Transactional);
    UMaterialExpressionConstant* GrassHeight = NewObject<UMaterialExpressionConstant>(Material, NAME_None, RF_Transactional);
    UMaterialExpressionLandscapeLayerBlend* LayerBlend = NewObject<UMaterialExpressionLandscapeLayerBlend>(Material, NAME_None, RF_Transactional);
    if (DirtColor == nullptr || DirtHeight == nullptr || GrassColor == nullptr || GrassHeight == nullptr || LayerBlend == nullptr)
    {
        OutError = TEXT("Failed to create LandscapeLayerBlend clipboard material expressions.");
        return false;
    }

    DirtColor->Material = Material;
    DirtColor->Constant = FLinearColor(0.28f, 0.18f, 0.08f, 1.0f);
    DirtColor->MaterialExpressionEditorX = -760;
    DirtColor->MaterialExpressionEditorY = -120;
    Material->GetExpressionCollection().AddExpression(DirtColor);

    DirtHeight->Material = Material;
    DirtHeight->R = 0.25f;
    DirtHeight->MaterialExpressionEditorX = -760;
    DirtHeight->MaterialExpressionEditorY = 40;
    Material->GetExpressionCollection().AddExpression(DirtHeight);

    GrassColor->Material = Material;
    GrassColor->Constant = FLinearColor(0.04f, 0.42f, 0.12f, 1.0f);
    GrassColor->MaterialExpressionEditorX = -760;
    GrassColor->MaterialExpressionEditorY = 220;
    Material->GetExpressionCollection().AddExpression(GrassColor);

    GrassHeight->Material = Material;
    GrassHeight->R = 0.75f;
    GrassHeight->MaterialExpressionEditorX = -760;
    GrassHeight->MaterialExpressionEditorY = 380;
    Material->GetExpressionCollection().AddExpression(GrassHeight);

    FLayerBlendInput DirtLayer;
    DirtLayer.LayerName = TEXT("Dirt");
    DirtLayer.BlendType = LB_HeightBlend;
    DirtLayer.PreviewWeight = 0.35f;
    DirtLayer.ConstLayerInput = FVector(0.2f, 0.1f, 0.05f);
    DirtLayer.ConstHeightInput = 0.2f;
    DirtLayer.LayerInput.Connect(0, DirtColor);
    DirtLayer.HeightInput.Connect(0, DirtHeight);

    FLayerBlendInput GrassLayer;
    GrassLayer.LayerName = TEXT("Grass");
    GrassLayer.BlendType = LB_HeightBlend;
    GrassLayer.PreviewWeight = 0.65f;
    GrassLayer.ConstLayerInput = FVector(0.05f, 0.35f, 0.08f);
    GrassLayer.ConstHeightInput = 0.8f;
    GrassLayer.LayerInput.Connect(0, GrassColor);
    GrassLayer.HeightInput.Connect(0, GrassHeight);

    LayerBlend->Material = Material;
    LayerBlend->Layers = { DirtLayer, GrassLayer };
    LayerBlend->MaterialExpressionEditorX = -320;
    LayerBlend->MaterialExpressionEditorY = 80;
    Material->GetExpressionCollection().AddExpression(LayerBlend);

    if (FExpressionInput* BaseColorInput = Material->GetExpressionInputForProperty(MP_BaseColor))
    {
        BaseColorInput->Connect(0, LayerBlend);
    }

    Material->MaterialGraph->RebuildGraph();

    if (UMaterialGraphNode* BlendNode = Cast<UMaterialGraphNode>(LayerBlend->GraphNode))
    {
        for (const UEdGraphPin* Pin : BlendNode->Pins)
        {
            UE_LOG(
                LogTemp,
                Display,
                TEXT("LandscapeLayerBlend pin: Direction=%s SourceIndex=%d PinName=\"%s\""),
                Pin->Direction == EGPD_Input ? TEXT("Input") : TEXT("Output"),
                Pin->SourceIndex,
                *Pin->PinName.ToString());
        }
    }

    return ExportExpressionsToClipboardSample(
        Path,
        { DirtColor, DirtHeight, GrassColor, GrassHeight, LayerBlend },
        TEXT("LandscapeLayerBlend"),
        OutError);
}

static bool ValidateClipboardT3D(const FString& Path, bool bImportNodes, FString& OutError)
{
    FString Text;
    if (!FFileHelper::LoadFileToString(Text, *Path))
    {
        OutError = FString::Printf(TEXT("Failed to read clipboard T3D: %s"), *Path);
        return false;
    }

    UMaterial* Material = NewObject<UMaterial>(
        GetTransientPackage(),
        TEXT("UEMatWorkflowClipboard"),
        RF_Transient | RF_Transactional);
    if (Material == nullptr)
    {
        OutError = TEXT("Failed to create transient validation material.");
        return false;
    }

    Material->bUseMaterialAttributes = true;
    Material->MaterialGraph = CastChecked<UMaterialGraph>(FBlueprintEditorUtils::CreateNewGraph(
        Material,
        FName(TEXT("MaterialGraph_0")),
        UMaterialGraph::StaticClass(),
        UMaterialGraphSchema::StaticClass()));
    Material->MaterialGraph->Material = Material;
    Material->MaterialGraph->RebuildGraph();

    if (!FEdGraphUtilities::CanImportNodesFromText(Material->MaterialGraph, Text))
    {
        OutError = FString::Printf(TEXT("UE rejected clipboard T3D in CanImportNodesFromText: %s"), *Path);
        return false;
    }

    if (bImportNodes)
    {
        TSet<UEdGraphNode*> ImportedNodes;
        FEdGraphUtilities::ImportNodesFromText(Material->MaterialGraph, Text, ImportedNodes);
        if (ImportedNodes.Num() == 0)
        {
            OutError = FString::Printf(TEXT("UE accepted clipboard T3D but imported zero nodes: %s"), *Path);
            return false;
        }
        UE_LOG(LogTemp, Display, TEXT("Imported clipboard nodes: %d"), ImportedNodes.Num());

        TArray<UMaterialExpression*> ImportedExpressions;
        for (UEdGraphNode* Node : ImportedNodes)
        {
            UMaterialGraphNode* MaterialNode = Cast<UMaterialGraphNode>(Node);
            UMaterialExpression* Expression = MaterialNode != nullptr ? MaterialNode->MaterialExpression : nullptr;
            if (Expression == nullptr)
            {
                continue;
            }

            Expression->Material = Material;
            Expression->Function = nullptr;
            Expression->SubgraphExpression = Material->MaterialGraph->SubgraphExpression;
            Material->GetExpressionCollection().AddExpression(Expression);
            ImportedExpressions.Add(Expression);
        }

        for (UMaterialExpression* Expression : ImportedExpressions)
        {
            Expression->PostCopyNode(ImportedExpressions);
        }

        Material->MaterialGraph->LinkMaterialExpressionsFromGraph();

        int32 MakeAttributesNodeCount = 0;
        auto ValidateAttributesInput = [&Text, &OutError](const TCHAR* PropertyName, const FExpressionInput& Input) -> bool
        {
            const FString Needle = FString::Printf(TEXT("%s=(Expression="), PropertyName);
            if (!Text.Contains(Needle))
            {
                return true;
            }
            if (Input.Expression == nullptr)
            {
                OutError = FString::Printf(TEXT("MakeMaterialAttributes input %s was serialized with an Expression but imported with a null Expression pointer."), PropertyName);
                return false;
            }
            return true;
        };

        for (UEdGraphNode* Node : ImportedNodes)
        {
            UMaterialGraphNode* MaterialNode = Cast<UMaterialGraphNode>(Node);
            UMaterialExpressionMakeMaterialAttributes* MakeAttributes = MaterialNode != nullptr
                ? Cast<UMaterialExpressionMakeMaterialAttributes>(MaterialNode->MaterialExpression)
                : nullptr;
            if (MakeAttributes == nullptr)
            {
                continue;
            }

            ++MakeAttributesNodeCount;
            if (!ValidateAttributesInput(TEXT("BaseColor"), MakeAttributes->BaseColor) ||
                !ValidateAttributesInput(TEXT("Metallic"), MakeAttributes->Metallic) ||
                !ValidateAttributesInput(TEXT("Specular"), MakeAttributes->Specular) ||
                !ValidateAttributesInput(TEXT("Roughness"), MakeAttributes->Roughness) ||
                !ValidateAttributesInput(TEXT("EmissiveColor"), MakeAttributes->EmissiveColor) ||
                !ValidateAttributesInput(TEXT("Opacity"), MakeAttributes->Opacity) ||
                !ValidateAttributesInput(TEXT("OpacityMask"), MakeAttributes->OpacityMask) ||
                !ValidateAttributesInput(TEXT("Normal"), MakeAttributes->Normal) ||
                !ValidateAttributesInput(TEXT("WorldPositionOffset"), MakeAttributes->WorldPositionOffset) ||
                !ValidateAttributesInput(TEXT("Refraction"), MakeAttributes->Refraction) ||
                !ValidateAttributesInput(TEXT("AmbientOcclusion"), MakeAttributes->AmbientOcclusion) ||
                !ValidateAttributesInput(TEXT("PixelDepthOffset"), MakeAttributes->PixelDepthOffset) ||
                !ValidateAttributesInput(TEXT("SubsurfaceColor"), MakeAttributes->SubsurfaceColor) ||
                !ValidateAttributesInput(TEXT("ClearCoat"), MakeAttributes->ClearCoat) ||
                !ValidateAttributesInput(TEXT("ClearCoatRoughness"), MakeAttributes->ClearCoatRoughness))
            {
                return false;
            }

            bool bHasOutputPin = false;
            for (const UEdGraphPin* Pin : MaterialNode->Pins)
            {
                if (Pin != nullptr && Pin->Direction == EGPD_Output && Pin->PinName == TEXT("Output"))
                {
                    bHasOutputPin = true;
                    break;
                }
            }
            if (!bHasOutputPin)
            {
                OutError = TEXT("Imported MakeMaterialAttributes graph node did not expose UE's expected Output pin.");
                return false;
            }
        }

        if (Text.Contains(TEXT("MaterialExpressionMakeMaterialAttributes")) && MakeAttributesNodeCount == 0)
        {
            OutError = TEXT("Clipboard T3D contains MakeMaterialAttributes text, but UE did not import a MakeMaterialAttributes expression.");
            return false;
        }
    }

    UE_LOG(LogTemp, Display, TEXT("Clipboard T3D validated by UE: %s"), *Path);
    return true;
}

static FString JsonStringField(const TSharedPtr<FJsonObject>& Object, const TCHAR* FieldName, const FString& DefaultValue = TEXT(""))
{
    if (!Object.IsValid())
    {
        return DefaultValue;
    }

    FString Value;
    return Object->TryGetStringField(FieldName, Value) ? Value : DefaultValue;
}

static TArray<TSharedPtr<FJsonValue>> JsonArrayField(const TSharedPtr<FJsonObject>& Object, const TCHAR* FieldName)
{
    const TArray<TSharedPtr<FJsonValue>>* Array = nullptr;
    if (Object.IsValid() && Object->TryGetArrayField(FieldName, Array) && Array != nullptr)
    {
        return *Array;
    }
    return {};
}

static TArray<FString> JsonStringArrayField(const TSharedPtr<FJsonObject>& Object, const TCHAR* FieldName)
{
    TArray<FString> Result;
    for (const TSharedPtr<FJsonValue>& Value : JsonArrayField(Object, FieldName))
    {
        FString StringValue;
        if (Value.IsValid() && Value->TryGetString(StringValue))
        {
            Result.Add(StringValue);
        }
    }
    return Result;
}

static TArray<FString> ReadNamesFromArray(const TSharedPtr<FJsonObject>& Object, const TCHAR* FieldName)
{
    TArray<FString> Names;
    for (const TSharedPtr<FJsonValue>& Value : JsonArrayField(Object, FieldName))
    {
        const TSharedPtr<FJsonObject> Item = Value.IsValid() ? Value->AsObject() : nullptr;
        const FString Name = JsonStringField(Item, TEXT("name"));
        if (!Name.IsEmpty())
        {
            Names.Add(Name);
        }
    }
    return Names;
}

static TMap<FString, TSharedPtr<FJsonObject>> ReadParamObjects(const TSharedPtr<FJsonObject>& NodeObject)
{
    TMap<FString, TSharedPtr<FJsonObject>> Params;
    for (const TSharedPtr<FJsonValue>& Value : JsonArrayField(NodeObject, TEXT("params")))
    {
        const TSharedPtr<FJsonObject> Item = Value.IsValid() ? Value->AsObject() : nullptr;
        const FString Name = JsonStringField(Item, TEXT("name"));
        if (!Name.IsEmpty())
        {
            Params.Add(Name, Item);
        }
    }
    return Params;
}

static UClass* ResolveExpressionClass(const FString& NodeType)
{
    static const TMap<FString, FString> ClassOverrides = BuildClassOverrides();

    TArray<FString> ClassPaths;
    if (const FString* Override = ClassOverrides.Find(NodeType))
    {
        if (Override->StartsWith(TEXT("/Script/")))
        {
            ClassPaths.Add(*Override);
        }
        else
        {
            ClassPaths.Add(FString::Printf(TEXT("/Script/Engine.%s"), **Override));
        }
    }
    ClassPaths.Add(FString::Printf(TEXT("/Script/Engine.MaterialExpression%s"), *NodeType));

    for (const FString& ClassPath : ClassPaths)
    {
        if (UClass* Class = FindObject<UClass>(nullptr, *ClassPath))
        {
            if (Class->IsChildOf(UMaterialExpression::StaticClass()))
            {
                return Class;
            }
        }
        if (UClass* Class = LoadObject<UClass>(nullptr, *ClassPath))
        {
            if (Class->IsChildOf(UMaterialExpression::StaticClass()))
            {
                return Class;
            }
        }
    }

    return nullptr;
}

static FString PropertyNameForInput(UMaterialExpression* Expression, int32 InputIndex, TMap<FString, int32>& PropertyOccurrences)
{
    TArray<FProperty*> Properties = Expression->GetInputPinProperty(InputIndex);
    if (Properties.Num() == 0 || Properties[0] == nullptr)
    {
        return Expression->GetInputName(InputIndex).ToString();
    }

    const FProperty* Property = Properties[0];
    FString PropertyName = Property->GetName();

    if (Property->ArrayDim > 1)
    {
        int32& Occurrence = PropertyOccurrences.FindOrAdd(PropertyName);
        PropertyName += FString::Printf(TEXT("(%d)"), Occurrence);
        ++Occurrence;
    }

    return PropertyName;
}

static TMap<FString, FString> BuildDisplayInputMap(UMaterialExpression* Expression)
{
    TMap<FString, FString> Map;
    TMap<FString, int32> PropertyOccurrences;

    for (int32 InputIndex = 0; Expression->GetInput(InputIndex) != nullptr; ++InputIndex)
    {
        const FString InputName = Expression->GetInputName(InputIndex).ToString();
        if (!InputName.IsEmpty())
        {
            Map.Add(InputName, PropertyNameForInput(Expression, InputIndex, PropertyOccurrences));
        }
    }

    return Map;
}

static bool ClassHasProperty(UClass* Class, const FString& PropertyName)
{
    const FString BaseProperty = PropertyName.LeftChop(PropertyName.EndsWith(TEXT(")") ) ? PropertyName.Len() - PropertyName.Find(TEXT("(")) : 0);
    return Class != nullptr && Class->FindPropertyByName(*(!BaseProperty.IsEmpty() ? BaseProperty : PropertyName)) != nullptr;
}

static FString ResolveInputProperty(const FString& NodeType, const FString& PinName, UClass* Class, UMaterialExpression* Expression)
{
    static const TMap<FString, TMap<FString, FString>> InputOverrides = BuildInputOverrides();
    if (const TMap<FString, FString>* NodeOverrides = InputOverrides.Find(NodeType))
    {
        if (const FString* Override = NodeOverrides->Find(PinName))
        {
            return *Override;
        }
    }

    if (ClassHasProperty(Class, PinName))
    {
        return PinName;
    }

    if (Expression != nullptr)
    {
        const TMap<FString, FString> DisplayMap = BuildDisplayInputMap(Expression);
        if (const FString* Property = DisplayMap.Find(PinName))
        {
            return *Property;
        }
    }

    return ClassHasProperty(Class, PinName) ? PinName : PinName;
}

static FString ResolveParamProperty(const FString& NodeType, const FString& ParamName)
{
    static const TMap<FString, TMap<FString, FString>> ParamOverrides = BuildParamPropertyOverrides();
    if (const TMap<FString, FString>* NodeOverrides = ParamOverrides.Find(NodeType))
    {
        if (const FString* Override = NodeOverrides->Find(ParamName))
        {
            return *Override;
        }
    }
    return ParamName;
}

static FString KindForParamType(const FString& Type)
{
    if (Type == TEXT("Float")) return TEXT("float");
    if (Type == TEXT("Int")) return TEXT("int");
    if (Type == TEXT("Bool")) return TEXT("bool");
    if (Type == TEXT("Name")) return TEXT("name");
    if (Type == TEXT("String")) return TEXT("string");
    if (Type == TEXT("Enum")) return TEXT("enum");
    if (Type == TEXT("Float3")) return TEXT("vector3");
    if (Type == TEXT("Float4")) return TEXT("vector4");
    if (Type == TEXT("TextureRef")) return TEXT("texture");
    return TEXT("string");
}

static void SetValueMap(TSharedRef<FJsonObject> ParamMeta, const FString& NodeType, const FString& ParamName, const TSharedPtr<FJsonObject>& ParamObject)
{
    if (ParamName == TEXT("SamplerType"))
    {
        SetValueMapFromPairs(ParamMeta, BuildSamplerTypeMap());
        return;
    }

    if (NodeType == TEXT("Transform") && ParamName == TEXT("Source"))
    {
        SetValueMapFromPairs(ParamMeta, BuildTransformSourceMap());
        return;
    }
    if (NodeType == TEXT("Transform") && ParamName == TEXT("Destination"))
    {
        SetValueMapFromPairs(ParamMeta, BuildTransformDestinationMap());
        return;
    }
    if (NodeType == TEXT("TransformPosition") && (ParamName == TEXT("Source") || ParamName == TEXT("Destination")))
    {
        SetValueMapFromPairs(ParamMeta, BuildTransformPositionMap());
        return;
    }

    const TArray<FString> Values = JsonStringArrayField(ParamObject, TEXT("values"));
    if (Values.Num() == 0)
    {
        return;
    }

    TSharedRef<FJsonObject> ValueMap = MakeShared<FJsonObject>();
    for (const FString& Value : Values)
    {
        ValueMap->SetStringField(Value, Value);
    }
    ParamMeta->SetObjectField(TEXT("valueMap"), ValueMap);
}

static TSharedPtr<FJsonObject> BuildVectorComponents(const FString& NodeType)
{
    TSharedPtr<FJsonObject> Components = MakeShared<FJsonObject>();
    if (NodeType == TEXT("Constant2Vector"))
    {
        Components->SetStringField(TEXT("R"), TEXT("R"));
        Components->SetStringField(TEXT("G"), TEXT("G"));
        return Components;
    }
    if (NodeType == TEXT("Constant3Vector"))
    {
        Components->SetStringField(TEXT("R"), TEXT("R"));
        Components->SetStringField(TEXT("G"), TEXT("G"));
        Components->SetStringField(TEXT("B"), TEXT("B"));
        return Components;
    }
    if (NodeType == TEXT("Constant4Vector"))
    {
        Components->SetStringField(TEXT("R"), TEXT("R"));
        Components->SetStringField(TEXT("G"), TEXT("G"));
        Components->SetStringField(TEXT("B"), TEXT("B"));
        Components->SetStringField(TEXT("A"), TEXT("A"));
        return Components;
    }
    return nullptr;
}

static void AddParamMeta(const FString& NodeType, const FString& ParamName, const TSharedPtr<FJsonObject>& ParamObject, TSharedRef<FJsonObject> ParamsObject)
{
    const FString Type = JsonStringField(ParamObject, TEXT("type"));
    TSharedRef<FJsonObject> ParamMeta = MakeShared<FJsonObject>();

    const TSharedPtr<FJsonObject> VectorComponents = BuildVectorComponents(NodeType);
    if (VectorComponents.IsValid() && ParamName == TEXT("R"))
    {
        ParamMeta->SetStringField(TEXT("property"), TEXT("Constant"));
        if (NodeType == TEXT("Constant2Vector"))
        {
            ParamMeta->SetStringField(TEXT("kind"), TEXT("vector2"));
        }
        else if (NodeType == TEXT("Constant3Vector"))
        {
            ParamMeta->SetStringField(TEXT("kind"), TEXT("vector3"));
        }
        else
        {
            ParamMeta->SetStringField(TEXT("kind"), TEXT("vector4"));
        }
        ParamMeta->SetObjectField(TEXT("components"), VectorComponents.ToSharedRef());
        ParamsObject->SetObjectField(ParamName, ParamMeta);
        return;
    }

    if (VectorComponents.IsValid() && (ParamName == TEXT("G") || ParamName == TEXT("B") || ParamName == TEXT("A")))
    {
        return;
    }

    ParamMeta->SetStringField(TEXT("property"), ResolveParamProperty(NodeType, ParamName));
    ParamMeta->SetStringField(TEXT("kind"), KindForParamType(Type));
    if (Type == TEXT("Enum"))
    {
        SetValueMap(ParamMeta, NodeType, ParamName, ParamObject);
    }
    ParamsObject->SetObjectField(ParamName, ParamMeta);
}

static TSharedRef<FJsonObject> BuildInputsObject(const FString& NodeType, const TArray<FString>& InputNames, UClass* Class, UMaterialExpression* Expression)
{
    TSharedRef<FJsonObject> InputsObject = MakeShared<FJsonObject>();
    for (const FString& PinName : InputNames)
    {
        TSharedRef<FJsonObject> InputMeta = MakeShared<FJsonObject>();
        InputMeta->SetStringField(TEXT("property"), ResolveInputProperty(NodeType, PinName, Class, Expression));
        InputsObject->SetObjectField(PinName, InputMeta);
    }
    return InputsObject;
}

static TSharedRef<FJsonObject> BuildOutputsObject(const TArray<FString>& OutputNames, UMaterialExpression* Expression)
{
    TSharedRef<FJsonObject> OutputsObject = MakeShared<FJsonObject>();
    TArray<FExpressionOutput> EngineOutputs;
    if (Expression != nullptr)
    {
        EngineOutputs = Expression->GetOutputs();
    }

    for (int32 Index = 0; Index < OutputNames.Num(); ++Index)
    {
        TSharedRef<FJsonObject> OutputMeta = MakeShared<FJsonObject>();
        OutputMeta->SetNumberField(TEXT("index"), Index);
        OutputsObject->SetObjectField(OutputNames[Index], OutputMeta);
    }

    return OutputsObject;
}

static TSharedRef<FJsonObject> BuildParamsObject(const FString& NodeType, const TMap<FString, TSharedPtr<FJsonObject>>& ParamObjects)
{
    TSharedRef<FJsonObject> ParamsObject = MakeShared<FJsonObject>();
    for (const TPair<FString, TSharedPtr<FJsonObject>>& Pair : ParamObjects)
    {
        AddParamMeta(NodeType, Pair.Key, Pair.Value, ParamsObject);
    }
    return ParamsObject;
}

static TMap<FString, TSharedPtr<FJsonObject>> ExportParamObjectsForNode(const FString& NodeType, const TMap<FString, TSharedPtr<FJsonObject>>& ParamObjects)
{
    if (NodeType != TEXT("Custom"))
    {
        return ParamObjects;
    }

    static const TSet<FString> CustomScalarParams =
    {
        TEXT("Code"),
        TEXT("Description"),
        TEXT("OutputType")
    };

    TMap<FString, TSharedPtr<FJsonObject>> FilteredParams;
    for (const TPair<FString, TSharedPtr<FJsonObject>>& Pair : ParamObjects)
    {
        if (CustomScalarParams.Contains(Pair.Key))
        {
            FilteredParams.Add(Pair.Key, Pair.Value);
        }
    }
    return FilteredParams;
}

static TSharedRef<FJsonObject> BuildFunctionInputsObject(const TArray<FString>& InputNames)
{
    TSharedRef<FJsonObject> InputsObject = MakeShared<FJsonObject>();
    for (int32 Index = 0; Index < InputNames.Num(); ++Index)
    {
        TSharedRef<FJsonObject> InputMeta = MakeShared<FJsonObject>();
        InputMeta->SetStringField(TEXT("property"), FString::Printf(TEXT("FunctionInputs(%d)"), Index));
        InputsObject->SetObjectField(InputNames[Index], InputMeta);
    }
    return InputsObject;
}

static FString ExistingSampleFor(const TSharedPtr<FJsonObject>& ExistingRoot, const FString& NodeType, bool bReserved)
{
    if (!ExistingRoot.IsValid())
    {
        return TEXT("");
    }

    const TSharedPtr<FJsonObject>* Section = nullptr;
    if (!ExistingRoot->TryGetObjectField(bReserved ? TEXT("reserved") : TEXT("nodes"), Section) || Section == nullptr || !Section->IsValid())
    {
        return TEXT("");
    }

    const TSharedPtr<FJsonObject>* Entry = nullptr;
    if (!(*Section)->TryGetObjectField(NodeType, Entry) || Entry == nullptr || !Entry->IsValid())
    {
        return TEXT("");
    }

    return JsonStringField(*Entry, TEXT("sample"));
}

static TSharedRef<FJsonObject> BuildNodeEntry(const FString& NodeType, const TSharedPtr<FJsonObject>& NodeObject, const TSharedPtr<FJsonObject>& ExistingRoot, int32& WarningCount)
{
    const bool bDynamic = DynamicNodeTypes.Contains(NodeType);
    static const TMap<FString, FString> FunctionAssetOverrides = BuildFunctionAssetOverrides();
    const FString* FunctionAsset = FunctionAssetOverrides.Find(NodeType);
    if (FunctionAsset != nullptr)
    {
        UClass* FunctionCallClass = ResolveExpressionClass(TEXT("MaterialFunctionCall"));
        UObject* FunctionObject = LoadObject<UObject>(nullptr, **FunctionAsset);

        TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("ueClass"), TEXT("/Script/Engine.MaterialExpressionMaterialFunctionCall"));
        Entry->SetObjectField(TEXT("inputs"), BuildFunctionInputsObject(ReadNamesFromArray(NodeObject, TEXT("inputs"))));
        Entry->SetObjectField(TEXT("outputs"), BuildOutputsObject(ReadNamesFromArray(NodeObject, TEXT("outputs")), nullptr));
        const TMap<FString, TSharedPtr<FJsonObject>> ParamObjects = ExportParamObjectsForNode(NodeType, ReadParamObjects(NodeObject));
        Entry->SetObjectField(TEXT("params"), BuildParamsObject(NodeType, ParamObjects));
        Entry->SetStringField(TEXT("sample"), ExistingSampleFor(ExistingRoot, NodeType, false));
        Entry->SetStringField(TEXT("functionRefProperty"), TEXT("MaterialFunction"));
        Entry->SetStringField(TEXT("functionAsset"), *FunctionAsset);

        if (FunctionCallClass != nullptr && FunctionObject != nullptr)
        {
            Entry->SetBoolField(TEXT("verified"), true);
            Entry->SetStringField(TEXT("note"), TEXT("Verified as a UE built-in Material Function call by commandlet asset loading."));
        }
        else
        {
            Entry->SetBoolField(TEXT("verified"), false);
            Entry->SetStringField(TEXT("note"), TEXT("Built-in Material Function asset or call class was not found by the commandlet."));
            ++WarningCount;
            UE_LOG(LogTemp, Warning, TEXT("Could not resolve built-in function node '%s' at '%s'"), *NodeType, **FunctionAsset);
        }

        return Entry;
    }

    UClass* Class = ResolveExpressionClass(NodeType);
    UMaterialExpression* Expression = Class != nullptr ? Cast<UMaterialExpression>(Class->GetDefaultObject()) : nullptr;

    TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
    Entry->SetStringField(TEXT("ueClass"), Class != nullptr ? Class->GetPathName() : FString::Printf(TEXT("/Script/Engine.MaterialExpression%s"), *NodeType));

    if (bDynamic)
    {
        Entry->SetObjectField(TEXT("inputs"), MakeShared<FJsonObject>());
        Entry->SetObjectField(TEXT("outputs"), MakeShared<FJsonObject>());
    }
    else
    {
        Entry->SetObjectField(TEXT("inputs"), BuildInputsObject(NodeType, ReadNamesFromArray(NodeObject, TEXT("inputs")), Class, Expression));
        Entry->SetObjectField(TEXT("outputs"), BuildOutputsObject(ReadNamesFromArray(NodeObject, TEXT("outputs")), Expression));
    }

    const TMap<FString, TSharedPtr<FJsonObject>> ParamObjects = ExportParamObjectsForNode(NodeType, ReadParamObjects(NodeObject));
    Entry->SetObjectField(TEXT("params"), BuildParamsObject(NodeType, ParamObjects));
    Entry->SetStringField(TEXT("sample"), ExistingSampleFor(ExistingRoot, NodeType, false));

    if (bDynamic)
    {
        Entry->SetBoolField(TEXT("verified"), false);
        Entry->SetBoolField(TEXT("dynamicExport"), true);
        Entry->SetStringField(TEXT("note"), TEXT("Dynamic-pin node; static export is intentionally skipped unless a per-instance exporter is implemented."));
    }
    else if (Class != nullptr)
    {
        Entry->SetBoolField(TEXT("verified"), true);
        if (NodeType == TEXT("Custom"))
        {
            Entry->SetStringField(TEXT("note"), TEXT("Inputs and AdditionalOutputs are emitted structurally by the Custom branch in ueT3D.ts; verified against viewer/tests/fixtures/ue-custom-node.t3d."));
        }
        else if (NodeType == TEXT("MakeMaterialAttributes"))
        {
            Entry->SetStringField(TEXT("note"), TEXT("Verified by UE reflection commandlet. Also the auto-collect target: graphToUET3D synthesizes one MakeMaterialAttributes per MaterialOutput and reroutes the root's attribute wires into it, so a pasted material needs a single MaterialAttributes wire (enable Use Material Attributes). See collectMaterialOutputs in viewer/web/src/export/ueT3D.ts."));
        }
        else if (NodeType == TEXT("TextureSampleParameterMovie"))
        {
            Entry->SetStringField(TEXT("note"), TEXT("Verified by UE reflection commandlet; UE 5.7 exports movie texture parameters through MaterialExpressionTextureSampleParameter2D."));
        }
        else
        {
            Entry->SetStringField(TEXT("note"), TEXT("Verified by UE reflection commandlet. Raw clipboard T3D sample is preserved only when already present."));
        }
    }
    else
    {
        Entry->SetBoolField(TEXT("verified"), false);
        Entry->SetStringField(TEXT("note"), TEXT("UE class was not found by the reflection commandlet; inspect class mapping before export."));
        ++WarningCount;
        UE_LOG(LogTemp, Warning, TEXT("Could not resolve UE material expression class for node type '%s'"), *NodeType);
    }

    return Entry;
}

static TSharedRef<FJsonObject> MakeReservedEntry(const FString& Type, const FString& ClassPath, const TSharedPtr<FJsonObject>& ExistingRoot)
{
    TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
    Entry->SetStringField(TEXT("ueClass"), ClassPath);
    Entry->SetObjectField(TEXT("inputs"), MakeShared<FJsonObject>());
    Entry->SetObjectField(TEXT("outputs"), MakeShared<FJsonObject>());
    Entry->SetObjectField(TEXT("params"), MakeShared<FJsonObject>());
    Entry->SetStringField(TEXT("sample"), ExistingSampleFor(ExistingRoot, Type, true));
    Entry->SetBoolField(TEXT("verified"), true);
    Entry->SetStringField(TEXT("note"), TEXT("Reserved exporter metadata maintained by commandlet defaults."));
    return Entry;
}

static TSharedRef<FJsonObject> BuildReservedObject(const TSharedPtr<FJsonObject>& ExistingRoot)
{
    TSharedRef<FJsonObject> Reserved = MakeShared<FJsonObject>();

    TSharedRef<FJsonObject> MaterialFunctionCall = MakeReservedEntry(TEXT("MaterialFunctionCall"), TEXT("/Script/Engine.MaterialExpressionMaterialFunctionCall"), ExistingRoot);
    MaterialFunctionCall->SetStringField(TEXT("functionRefProperty"), TEXT("MaterialFunction"));
    Reserved->SetObjectField(TEXT("MaterialFunctionCall"), MaterialFunctionCall);

    TSharedRef<FJsonObject> FunctionInput = MakeReservedEntry(TEXT("FunctionInput"), TEXT("/Script/Engine.MaterialExpressionFunctionInput"), ExistingRoot);
    TSharedRef<FJsonObject> FunctionInputOutputs = MakeShared<FJsonObject>();
    TSharedRef<FJsonObject> InputOutput = MakeShared<FJsonObject>();
    InputOutput->SetNumberField(TEXT("index"), 0);
    FunctionInputOutputs->SetObjectField(TEXT("Input"), InputOutput);
    FunctionInput->SetObjectField(TEXT("outputs"), FunctionInputOutputs);
    TSharedRef<FJsonObject> FunctionInputParams = MakeShared<FJsonObject>();
    TSharedRef<FJsonObject> InputName = MakeShared<FJsonObject>();
    InputName->SetStringField(TEXT("property"), TEXT("InputName"));
    InputName->SetStringField(TEXT("kind"), TEXT("name"));
    FunctionInputParams->SetObjectField(TEXT("InputName"), InputName);
    TSharedRef<FJsonObject> InputType = MakeShared<FJsonObject>();
    InputType->SetStringField(TEXT("property"), TEXT("InputType"));
    InputType->SetStringField(TEXT("kind"), TEXT("enum"));
    FunctionInputParams->SetObjectField(TEXT("InputType"), InputType);
    FunctionInput->SetObjectField(TEXT("params"), FunctionInputParams);
    Reserved->SetObjectField(TEXT("FunctionInput"), FunctionInput);

    TSharedRef<FJsonObject> FunctionOutput = MakeReservedEntry(TEXT("FunctionOutput"), TEXT("/Script/Engine.MaterialExpressionFunctionOutput"), ExistingRoot);
    TSharedRef<FJsonObject> FunctionOutputInputs = MakeShared<FJsonObject>();
    TSharedRef<FJsonObject> OutputInput = MakeShared<FJsonObject>();
    OutputInput->SetStringField(TEXT("property"), TEXT("A"));
    FunctionOutputInputs->SetObjectField(TEXT("Input"), OutputInput);
    FunctionOutput->SetObjectField(TEXT("inputs"), FunctionOutputInputs);
    TSharedRef<FJsonObject> FunctionOutputParams = MakeShared<FJsonObject>();
    TSharedRef<FJsonObject> OutputName = MakeShared<FJsonObject>();
    OutputName->SetStringField(TEXT("property"), TEXT("OutputName"));
    OutputName->SetStringField(TEXT("kind"), TEXT("name"));
    FunctionOutputParams->SetObjectField(TEXT("OutputName"), OutputName);
    FunctionOutput->SetObjectField(TEXT("params"), FunctionOutputParams);
    Reserved->SetObjectField(TEXT("FunctionOutput"), FunctionOutput);

    return Reserved;
}

// Dump UE's full MaterialAttributes registry as [{ name, guid }, ...]. Each FGuid is exactly
// what UE serialises into AttributeSetTypes(n)/AttributeGetTypes(n), so the viewer's exporter
// can key Set/Get export on real GUIDs for ALL attributes instead of the handful captured from
// clipboard fixtures (see viewer/web/src/export/ueT3D.ts -> buildAttributeTable, and the
// material-attribute-guids.ts fallback used when this section is absent).
//
// API NOTE (verify against the installed engine headers when compiling): this uses
// FMaterialAttributeDefinitionMap::GetAttributeNameToIDList, the same registry the Set/Get
// attribute pickers read. If that symbol differs in this UE version, the equivalent is to call
// GetAttributeList(TArray<FGuid>&) and GetAttributeName(const FGuid&) per entry. FGuid::ToString()
// (default = EGuidFormats::Digits, 32 hex) already matches the fixture GUID format.
static TArray<TSharedPtr<FJsonValue>> BuildMaterialAttributesArray()
{
    TArray<TSharedPtr<FJsonValue>> Out;

    TArray<TPair<FString, FGuid>> NameToId;
    FMaterialAttributeDefinitionMap::GetAttributeNameToIDList(NameToId);
    NameToId.Sort([](const TPair<FString, FGuid>& A, const TPair<FString, FGuid>& B)
    {
        return A.Key < B.Key;
    });

    for (const TPair<FString, FGuid>& Pair : NameToId)
    {
        if (!Pair.Value.IsValid())
        {
            continue;
        }
        TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("name"), Pair.Key);
        Entry->SetStringField(TEXT("guid"), Pair.Value.ToString());
        Out.Add(MakeShared<FJsonValueObject>(Entry));
    }

    return Out;
}
} // namespace UE::MatExportMetadata

UUEMatExportMetadataCommandlet::UUEMatExportMetadataCommandlet()
{
    IsClient = false;
    IsEditor = true;
    IsServer = false;
    LogToConsole = true;
}

int32 UUEMatExportMetadataCommandlet::Main(const FString& Params)
{
    using namespace UE::MatExportMetadata;

    FString ClipboardInPath;
    if (FParse::Value(*Params, TEXT("ClipboardIn="), ClipboardInPath))
    {
        ClipboardInPath = ToAbsolutePath(ClipboardInPath);
        const bool bImportNodes = FParse::Param(*Params, TEXT("ImportClipboard"));
        FString Error;
        if (!ValidateClipboardT3D(ClipboardInPath, bImportNodes, Error))
        {
            UE_LOG(LogTemp, Error, TEXT("%s"), *Error);
            return 9;
        }
        return 0;
    }

    FString TextureSampleSourcesOutPath;
    if (FParse::Value(*Params, TEXT("TextureSampleSourcesOut="), TextureSampleSourcesOutPath))
    {
        TextureSampleSourcesOutPath = ToAbsolutePath(TextureSampleSourcesOutPath);
        FString TextureAssetPath;
        if (!FParse::Value(*Params, TEXT("TextureAsset="), TextureAssetPath) || TextureAssetPath.IsEmpty())
        {
            UE_LOG(LogTemp, Error, TEXT("TextureAsset is required when using TextureSampleSourcesOut."));
            return 10;
        }

        FString Error;
        if (!WriteTextureSampleClipboardSample(TextureSampleSourcesOutPath, TextureAssetPath, Error))
        {
            UE_LOG(LogTemp, Error, TEXT("%s"), *Error);
            return 10;
        }
        return 0;
    }

    FString CoreClipboardOutPath;
    if (FParse::Value(*Params, TEXT("CoreClipboardOut="), CoreClipboardOutPath))
    {
        CoreClipboardOutPath = ToAbsolutePath(CoreClipboardOutPath);
        FString TextureAssetPath;
        if (!FParse::Value(*Params, TEXT("TextureAsset="), TextureAssetPath) || TextureAssetPath.IsEmpty())
        {
            UE_LOG(LogTemp, Error, TEXT("TextureAsset is required when using CoreClipboardOut."));
            return 11;
        }

        FString Error;
        if (!WriteCoreClipboardSample(CoreClipboardOutPath, TextureAssetPath, Error))
        {
            UE_LOG(LogTemp, Error, TEXT("%s"), *Error);
            return 11;
        }
        return 0;
    }

    FString NamedRerouteSampleOutPath;
    if (FParse::Value(*Params, TEXT("NamedRerouteSampleOut="), NamedRerouteSampleOutPath))
    {
        NamedRerouteSampleOutPath = ToAbsolutePath(NamedRerouteSampleOutPath);
        FString Error;
        if (!WriteNamedRerouteClipboardSample(NamedRerouteSampleOutPath, Error))
        {
            UE_LOG(LogTemp, Error, TEXT("%s"), *Error);
            return 12;
        }
        return 0;
    }

    FString MakeMaterialAttributesSampleOutPath;
    if (FParse::Value(*Params, TEXT("MakeMaterialAttributesSampleOut="), MakeMaterialAttributesSampleOutPath))
    {
        MakeMaterialAttributesSampleOutPath = ToAbsolutePath(MakeMaterialAttributesSampleOutPath);
        FString Error;
        if (!WriteMakeMaterialAttributesClipboardSample(MakeMaterialAttributesSampleOutPath, Error))
        {
            UE_LOG(LogTemp, Error, TEXT("%s"), *Error);
            return 8;
        }
        return 0;
    }

    FString SetMaterialAttributesSampleOutPath;
    if (FParse::Value(*Params, TEXT("SetMaterialAttributesSampleOut="), SetMaterialAttributesSampleOutPath))
    {
        SetMaterialAttributesSampleOutPath = ToAbsolutePath(SetMaterialAttributesSampleOutPath);
        FString Error;
        if (!WriteSetMaterialAttributesClipboardSample(SetMaterialAttributesSampleOutPath, Error))
        {
            UE_LOG(LogTemp, Error, TEXT("%s"), *Error);
            return 13;
        }
        return 0;
    }

    FString GetMaterialAttributesSampleOutPath;
    if (FParse::Value(*Params, TEXT("GetMaterialAttributesSampleOut="), GetMaterialAttributesSampleOutPath))
    {
        GetMaterialAttributesSampleOutPath = ToAbsolutePath(GetMaterialAttributesSampleOutPath);
        FString Error;
        if (!WriteGetMaterialAttributesClipboardSample(GetMaterialAttributesSampleOutPath, Error))
        {
            UE_LOG(LogTemp, Error, TEXT("%s"), *Error);
            return 14;
        }
        return 0;
    }

    FString LandscapeLayerBlendSampleOutPath;
    if (FParse::Value(*Params, TEXT("LandscapeLayerBlendSampleOut="), LandscapeLayerBlendSampleOutPath))
    {
        LandscapeLayerBlendSampleOutPath = ToAbsolutePath(LandscapeLayerBlendSampleOutPath);
        FString Error;
        if (!WriteLandscapeLayerBlendClipboardSample(LandscapeLayerBlendSampleOutPath, Error))
        {
            UE_LOG(LogTemp, Error, TEXT("%s"), *Error);
            return 15;
        }
        return 0;
    }

    FString NodeDbPath;
    FString OutPath;
    const bool bHasNodeDb = FParse::Value(*Params, TEXT("NodeDb="), NodeDbPath);
    const bool bHasOut = FParse::Value(*Params, TEXT("Out="), OutPath);
    const bool bStrict = FParse::Param(*Params, TEXT("Strict"));

    if (!bHasNodeDb || !bHasOut)
    {
        UE_LOG(LogTemp, Error, TEXT("Usage: -run=UEMatExportMetadata -NodeDb=<nodes-ue5.7.json> -Out=<nodes-ue5.7.export.json> [-Strict]"));
        UE_LOG(LogTemp, Error, TEXT("   or: -run=UEMatExportMetadata -MakeMaterialAttributesSampleOut=<fixture.t3d>"));
        UE_LOG(LogTemp, Error, TEXT("   or: -run=UEMatExportMetadata -CoreClipboardOut=<fixture.t3d> -TextureAsset=<Texture2D object path>"));
        UE_LOG(LogTemp, Error, TEXT("   or: -run=UEMatExportMetadata -TextureSampleSourcesOut=<fixture.t3d> -TextureAsset=<Texture2D object path>"));
        UE_LOG(LogTemp, Error, TEXT("   or: -run=UEMatExportMetadata -NamedRerouteSampleOut=<fixture.t3d>"));
        UE_LOG(LogTemp, Error, TEXT("   or: -run=UEMatExportMetadata -SetMaterialAttributesSampleOut=<fixture.t3d>"));
        UE_LOG(LogTemp, Error, TEXT("   or: -run=UEMatExportMetadata -GetMaterialAttributesSampleOut=<fixture.t3d>"));
        UE_LOG(LogTemp, Error, TEXT("   or: -run=UEMatExportMetadata -LandscapeLayerBlendSampleOut=<fixture.t3d>"));
        UE_LOG(LogTemp, Error, TEXT("   or: -run=UEMatExportMetadata -ClipboardIn=<clipboard.t3d> [-ImportClipboard]"));
        return 2;
    }

    NodeDbPath = ToAbsolutePath(NodeDbPath);
    OutPath = ToAbsolutePath(OutPath);

    FString Error;
    TSharedPtr<FJsonObject> DbRoot;
    if (!LoadJsonFile(NodeDbPath, DbRoot, Error))
    {
        UE_LOG(LogTemp, Error, TEXT("%s"), *Error);
        return 3;
    }

    TSharedPtr<FJsonObject> ExistingRoot;
    if (IFileManager::Get().FileExists(*OutPath))
    {
        FString ExistingError;
        LoadJsonFile(OutPath, ExistingRoot, ExistingError);
    }

    const TSharedPtr<FJsonObject>* NodesObject = nullptr;
    if (!DbRoot->TryGetObjectField(TEXT("nodes"), NodesObject) || NodesObject == nullptr || !NodesObject->IsValid())
    {
        UE_LOG(LogTemp, Error, TEXT("Node DB is missing the top-level 'nodes' object: %s"), *NodeDbPath);
        return 4;
    }

    int32 WarningCount = 0;
    TSharedRef<FJsonObject> OutRoot = MakeShared<FJsonObject>();
    OutRoot->SetStringField(TEXT("schemaVersion"), TEXT("1.0"));
    OutRoot->SetStringField(TEXT("ueVersion"), JsonStringField(DbRoot, TEXT("ueVersion"), TEXT("5.7")));
    OutRoot->SetStringField(TEXT("generatedAt"), FDateTime::UtcNow().ToIso8601());
    OutRoot->SetStringField(TEXT("source"), TEXT("Generated by UEMatExportMetadata UE Editor commandlet using UE reflection."));

    TSharedRef<FJsonObject> OutNodes = MakeShared<FJsonObject>();
    for (const TPair<FString, TSharedPtr<FJsonValue>>& Pair : (*NodesObject)->Values)
    {
        const TSharedPtr<FJsonObject> NodeObject = Pair.Value.IsValid() ? Pair.Value->AsObject() : nullptr;
        if (!NodeObject.IsValid())
        {
            ++WarningCount;
            UE_LOG(LogTemp, Warning, TEXT("Node DB entry is not an object: %s"), *Pair.Key);
            continue;
        }
        OutNodes->SetObjectField(Pair.Key, BuildNodeEntry(Pair.Key, NodeObject, ExistingRoot, WarningCount));
    }
    OutRoot->SetObjectField(TEXT("nodes"), OutNodes);
    OutRoot->SetObjectField(TEXT("reserved"), BuildReservedObject(ExistingRoot));
    OutRoot->SetArrayField(TEXT("materialAttributes"), BuildMaterialAttributesArray());

    FString OutputText;
    const TSharedRef<TJsonWriter<TCHAR, TPrettyJsonPrintPolicy<TCHAR>>> Writer =
        TJsonWriterFactory<TCHAR, TPrettyJsonPrintPolicy<TCHAR>>::Create(&OutputText);
    if (!FJsonSerializer::Serialize(OutRoot, Writer))
    {
        UE_LOG(LogTemp, Error, TEXT("Failed to serialize export metadata JSON."));
        return 5;
    }

    IFileManager::Get().MakeDirectory(*FPaths::GetPath(OutPath), true);
    if (!FFileHelper::SaveStringToFile(OutputText, *OutPath))
    {
        UE_LOG(LogTemp, Error, TEXT("Failed to write export metadata: %s"), *OutPath);
        return 6;
    }

    UE_LOG(LogTemp, Display, TEXT("Wrote UE export metadata: %s"), *OutPath);
    UE_LOG(LogTemp, Display, TEXT("Warnings: %d"), WarningCount);
    return bStrict && WarningCount > 0 ? 7 : 0;
}
